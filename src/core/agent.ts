import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { channels, formatMessages } from './channel.js';
import type { PendingQuestion } from './types.js';

/** our own in-process tools; auto-approved rather than re-asked per call */
const COLINEAR_TOOL_PREFIX = 'mcp__colinear__';

/**
 * Per-session coordination tools (EXPERIMENTAL). Identity is enforced by
 * construction: the channel and username are closed over at spawn, so there
 * is no `from` or `channel` parameter for an agent to spoof.
 */
function coordinationServer(channel: string, username: string) {
  return createSdkMcpServer({
    name: 'colinear',
    tools: [
      tool(
        'channel_read',
        `Read new messages on your coordination channel ${channel} (since your last read; you never see the same message twice).`,
        {},
        async () => ({
          content: [{ type: 'text' as const, text: formatMessages(channels.readSince(channel, username)) }],
        }),
      ),
      tool(
        'channel_post',
        `Post a short message (max ~2 lines) to your coordination channel ${channel}. Your name is stamped automatically.`,
        { message: z.string().min(1).max(500) },
        async ({ message }) => {
          channels.post(channel, username, 'agent', message);
          return { content: [{ type: 'text' as const, text: 'posted' }] };
        },
      ),
    ],
  });
}

/**
 * A live session's mailbox. Handing `query()` an async iterable instead of a
 * string keeps the conversation open between turns, so the operator can say
 * something to a working agent without attaching to it.
 *
 * Delivery is at the next turn boundary — a message can't interrupt a bash
 * command that's already running, and pretending otherwise would just make
 * the UI lie.
 */
export class SessionInbox {
  private queue: string[] = [];
  private wake?: () => void;
  private closed = false;

  /** false when the session has already finished — caller should queue it instead */
  push(text: string): boolean {
    if (this.closed) return false;
    this.queue.push(text);
    this.wake?.();
    return true;
  }

  get pending(): number {
    return this.queue.length;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  /** The prompt stream: the opening prompt, then whatever the operator sends. */
  async *stream(first: string): AsyncIterable<SDKUserMessage> {
    yield userMessage(first);
    while (!this.closed) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield userMessage(next);
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
}

export interface SessionCallbacks {
  onActivity: (line: string) => void;
  onSessionId: (id: string) => void;
  onQuestion: (q: PendingQuestion) => void;
  onUsage?: (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void;
}

export interface SessionResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  isError: boolean;
  errors: string[];
  /** assistant messages seen — 0 on a spawn that died before doing anything */
  assistantTurns: number;
}

interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

export async function runSession(opts: {
  prompt: string;
  cwd: string;
  callbacks: SessionCallbacks;
  outputSchema?: Record<string, unknown>;
  model?: string;
  maxTurns?: number;
  /** session id to resume (continues its transcript) */
  resume?: string;
  abortController?: AbortController;
  /** EXPERIMENTAL coordination channel; identity baked in at spawn */
  channel?: { id: string; username: string };
  /** keeps the session open for operator messages (see SessionInbox) */
  inbox?: SessionInbox;
}): Promise<SessionResult> {
  const { prompt, cwd, callbacks, outputSchema, model, maxTurns, resume, abortController, channel, inbox } = opts;

  const q = query({
    prompt: inbox ? inbox.stream(prompt) : prompt,
    options: {
      cwd,
      model,
      maxTurns,
      resume,
      abortController,
      // auto: the classifier approves routine work and only risky/uncertain
      // calls fall through to canUseTool below (haiku predates auto support)
      permissionMode: model?.includes('haiku') ? 'acceptEdits' : 'auto',
      settingSources: ['project'],
      ...(channel ? { mcpServers: { colinear: coordinationServer(channel.id, channel.username) } } : {}),
      ...(outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } } : {}),
      canUseTool: async (toolName, input) => {
        // our own tools post to a channel this agent is already a member of —
        // asking the operator per message would make coordination unusable
        if (toolName.startsWith(COLINEAR_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: input };
        if (toolName === 'AskUserQuestion') {
          const parsed = input as AskUserQuestionInput;
          const first = parsed.questions?.[0];
          const answer = await new Promise<string>((resolve) => {
            callbacks.onQuestion({
              text: first?.question ?? JSON.stringify(input).slice(0, 300),
              options: (first?.options ?? []).map((o) => o.label ?? '').filter(Boolean),
              answer: resolve,
            });
          });
          return {
            behavior: 'deny',
            message: `The user answered: "${answer}". This is not an error — continue working based on this answer, and do not ask this question again.`,
            interrupt: false,
          };
        }
        // only reached when the auto-mode classifier blocked the call or
        // couldn't decide — ask the operator instead of rubber-stamping
        const answer = await new Promise<string>((resolve) => {
          callbacks.onQuestion({
            text: `⚒ wants to run ${toolName}: ${describeInput(input)}`,
            options: ['allow', 'deny'],
            answer: resolve,
          });
        });
        if (answer === 'allow') return { behavior: 'allow', updatedInput: input };
        return {
          behavior: 'deny',
          message:
            'The operator denied this action. Do not retry it as-is — find a safer approach, or ask what to do via AskUserQuestion.',
          interrupt: false,
        };
      },
    },
  });

  const result: SessionResult = { text: '', costUsd: 0, isError: false, errors: [], assistantTurns: 0 };

  for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') callbacks.onSessionId(msg.session_id);
        break;
      case 'assistant': {
        result.assistantTurns++;
        const usage = msg.message.usage;
        if (usage && callbacks.onUsage) {
          // mirror Claude Code's /cost split: cache traffic reported apart
          // from real input, or 40 cached turns read as millions of tokens
          callbacks.onUsage({
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
          });
        }
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            callbacks.onActivity(firstLine(block.text));
          } else if (block.type === 'tool_use') {
            callbacks.onActivity(`⚒ ${block.name} ${summarizeInput(block.input)}`);
          }
        }
        break;
      }
      case 'result': {
        // total_cost_usd is the session total, so the last turn's figure is
        // the answer — summing would double-count a multi-turn session
        result.costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success') {
          result.text = msg.result;
          result.structured = msg.structured_output;
        } else {
          result.isError = true;
          result.errors = msg.errors;
        }
        // A streaming session doesn't end on its own: it waits for more input.
        // Close it now unless the operator got a message in first, in which
        // case the agent takes one more turn to deal with it.
        if (inbox && (result.isError || inbox.pending === 0)) inbox.close();
        break;
      }
      default:
        break;
    }
  }

  return result;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0].slice(0, 120);
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const hint = o.file_path ?? o.command ?? o.pattern ?? o.description ?? '';
    if (typeof hint === 'string' && hint) return hint.slice(0, 80);
  }
  return '';
}

/** fuller than summarizeInput: permission questions must show the whole command */
function describeInput(input: unknown): string {
  const hint = summarizeInput(input);
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const full = o.command ?? o.file_path ?? o.url ?? '';
    if (typeof full === 'string' && full) return full.slice(0, 300);
  }
  return hint || JSON.stringify(input ?? {}).slice(0, 300);
}
