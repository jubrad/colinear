import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { channels, formatMessages } from './channel.js';
import type { PendingQuestion } from './types.js';

/**
 * Per-session coordination tools. Identity is enforced by construction: the
 * channel and username are closed over at spawn — there is no from/channel
 * parameter for the agent to spoof.
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
          content: [{ type: 'text', text: formatMessages(channels.readSince(channel, username)) }],
        }),
      ),
      tool(
        'channel_post',
        `Post a short message (max ~2 lines) to your coordination channel ${channel}. Your name is stamped automatically.`,
        { message: z.string().min(1).max(500) },
        async ({ message }) => {
          channels.post(channel, username, 'agent', message);
          return { content: [{ type: 'text', text: 'posted' }] };
        },
      ),
    ],
  });
}

export interface SessionCallbacks {
  onActivity: (line: string) => void;
  onSessionId: (id: string) => void;
  onQuestion: (q: PendingQuestion) => void;
  onUsage?: (u: { input: number; output: number }) => void;
}

export interface SessionResult {
  text: string;
  structured?: unknown;
  costUsd: number;
  isError: boolean;
  errors: string[];
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
  /** coordination channel membership (identity baked in at spawn) */
  channel?: { id: string; username: string };
}): Promise<SessionResult> {
  const { prompt, cwd, callbacks, outputSchema, model, maxTurns, resume, abortController, channel } = opts;

  const q = query({
    prompt,
    options: {
      cwd,
      model,
      maxTurns,
      resume,
      abortController,
      permissionMode: 'acceptEdits',
      settingSources: ['project'],
      ...(channel
        ? { mcpServers: { colinear: coordinationServer(channel.id, channel.username) } }
        : {}),
      ...(outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } } : {}),
      canUseTool: async (toolName, input) => {
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
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  const result: SessionResult = { text: '', costUsd: 0, isError: false, errors: [] };

  for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') callbacks.onSessionId(msg.session_id);
        break;
      case 'assistant': {
        const usage = (msg.message as { usage?: Record<string, number | undefined> }).usage;
        if (usage && callbacks.onUsage) {
          callbacks.onUsage({
            input:
              (usage.input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0),
            output: usage.output_tokens ?? 0,
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
        result.costUsd = msg.total_cost_usd;
        if (msg.subtype === 'success') {
          result.text = msg.result;
          result.structured = msg.structured_output;
        } else {
          result.isError = true;
          result.errors = msg.errors;
        }
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
