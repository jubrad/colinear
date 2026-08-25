import {
  createSdkMcpServer,
  query,
  tool,
  type PermissionMode,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { channels, formatMessages } from './channel.js';
import type { CoordinatorTools } from './coordinator.js';
import { endSession, startSession, updateSession, type AgentKind } from './sessions.js';
import type { SessionChannels } from './channel.js';
import type { AskedQuestion, PendingQuestion, PlannedSubtask } from './types.js';

/** our own in-process tools; auto-approved rather than re-asked per call */
const COLINEAR_TOOL_PREFIX = 'mcp__colinear__';

/**
 * The in-process tool server a session gets, if any. Both surfaces are built
 * per session with their subject closed over — the channel and username for
 * coordination, the family for a coordinator — so identity and scope are
 * enforced by construction and there is no parameter for an agent to lie in.
 */
function colinearServer(opts: {
  channels?: SessionChannels;
  coordinator?: CoordinatorTools;
}) {
  const tools = [];
  const membership = opts.channels;
  if (membership && membership.scopes.length) {
    const { username, scopes } = membership;
    const byScope = new Map(scopes.map((s) => [s.scope, s.id]));
    const only = scopes[0].id;
    // the scope is an enum of the channels this session is actually in, so an
    // agent still cannot address one it doesn't belong to — the parameter
    // picks among memberships, it doesn't name a channel
    const scopeArg = z
      .enum(scopes.map((s) => s.scope) as [string, ...string[]])
      .optional()
      .describe(scopes.map((s) => `${s.scope} = ${s.id}`).join(', '));
    const resolve = (scope?: string) => byScope.get(scope as 'family' | 'project') ?? only;
    const list = scopes.map((s) => `${s.id} (${s.scope})`).join(' and ');
    tools.push(
      tool(
        'channel_read',
        `Read new messages on your coordination channel(s): ${list}. Only what you haven't seen; you never get the same message twice.`,
        { scope: scopeArg },
        async ({ scope }) => {
          const channel = resolve(scope as string | undefined);
          return {
            content: [{ type: 'text' as const, text: formatMessages(channels.readSince(channel, username)) }],
          };
        },
      ),
      tool(
        'channel_post',
        `Post a short message (max ~2 lines) to a channel you are in: ${list}. Your name is stamped automatically.`,
        { message: z.string().min(1).max(500), scope: scopeArg },
        async ({ message, scope }) => {
          const channel = resolve(scope as string | undefined);
          channels.post(channel, username, 'agent', message);
          return { content: [{ type: 'text' as const, text: `posted to ${channel}` }] };
        },
      ),
    );
  }
  const co = opts.coordinator;
  if (co) {
    tools.push(
      tool('family_status', 'The live state of every sub-issue in this family.', {}, async () => ({
        content: [{ type: 'text' as const, text: co.status() }],
      })),
      tool(
        'family_message',
        "Send a sub-issue's agent an instruction. A running agent reads it at its next turn; an idle one is woken to read it.",
        { identifier: z.string().min(1), text: z.string().min(1).max(2000) },
        async ({ identifier, text }) => ({
          content: [{ type: 'text' as const, text: co.message(identifier, text) }],
        }),
      ),
      tool(
        'family_cancel',
        "Stop a sub-issue's agent. The operator can resume it later; say why.",
        { identifier: z.string().min(1), reason: z.string().min(1).max(500) },
        async ({ identifier, reason }) => ({
          content: [{ type: 'text' as const, text: co.cancel(identifier, reason) }],
        }),
      ),
      tool(
        'family_propose',
        'Propose new sub-issues. This does NOT create them — the operator reviews and approves. Tell them what you proposed and that it is waiting on them.',
        {
          subtasks: z
            .array(
              z.object({
                title: z.string().min(1),
                description: z.string().min(1),
                repo: z.string().optional(),
                blockedBy: z.array(z.number()).optional(),
              }),
            )
            .min(1)
            .max(10),
        },
        async ({ subtasks }) => ({
          content: [{ type: 'text' as const, text: co.propose(subtasks as PlannedSubtask[]) }],
        }),
      ),
    );
  }
  return tools.length ? createSdkMcpServer({ name: 'colinear', tools }) : undefined;
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
  /** yielded to the SDK, but no turn has completed behind it yet */
  private inFlight: string[] = [];
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

  /**
   * Messages that may never have been read. The SDK pulls from the stream as
   * soon as something is yielded — long before the agent acts on it — so a
   * message is only certainly delivered once a turn has completed behind it.
   * Anything still in flight when a session dies comes back here, and the
   * caller puts it on the task for next time.
   *
   * Biased towards saying it twice rather than losing it: a repeated
   * instruction is a wasted paragraph, a dropped one is a silent no-op.
   */
  drain(): string[] {
    const out = [...this.inFlight, ...this.queue];
    this.inFlight = [];
    this.queue = [];
    return out;
  }

  /** A turn completed: whatever was in flight is now part of the conversation. */
  markDelivered(): void {
    this.inFlight = [];
  }

  /** The prompt stream: the opening prompt, then whatever the operator sends. */
  async *stream(first: string): AsyncIterable<SDKUserMessage> {
    yield userMessage(first);
    while (!this.closed) {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.inFlight.push(next);
        // stamped here, not by the caller, so what drain() returns is the raw
        // text and a re-queued message can't collect a second prefix
        yield userMessage(`Message from the operator: ${next}`);
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
    header?: string;
    multiSelect?: boolean;
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
  /** EXPERIMENTAL coordination channels; identity baked in at spawn */
  channels?: SessionChannels;
  /** keeps the session open for operator messages (see SessionInbox) */
  inbox?: SessionInbox;
  /** EXPERIMENTAL: family-management tools for a tracking parent */
  coordinator?: CoordinatorTools;
  /** how much the agent may do on its own, and the operator's deny list */
  permissions?: { mode?: string; deny?: string[] };
  /**
   * How this session appears in `:agents`. Registration lives here rather than
   * at the call sites so a new kind of agent cannot be started invisibly.
   */
  agent?: {
    kind: AgentKind;
    label: string;
    origin: string;
    /** the registry id, as soon as there is one — for a caller that wants to point at it */
    onRegistered?: (id: string) => void;
  };
}): Promise<SessionResult> {
  const {
    prompt, cwd, callbacks, outputSchema, model, maxTurns, resume, abortController,
    channels: membership, inbox, coordinator, permissions,
  } = opts;
  const mcp = colinearServer({ channels: membership, coordinator });

  const q = query({
    prompt: inbox ? inbox.stream(prompt) : prompt,
    options: {
      cwd,
      model,
      maxTurns,
      resume,
      abortController,
      // auto (the default) has a classifier approve routine work, with risky or
      // uncertain calls falling through to canUseTool below. haiku predates it.
      permissionMode: (model?.includes('haiku') ? 'acceptEdits' : permissions?.mode ?? 'auto') as PermissionMode,
      // 'project' loads the repo's own .claude/settings.json and CLAUDE.md
      settingSources: ['project'],
      // policy tier: the operator's deny/ask rules, from a config file outside
      // the worktree. A repo's own settings can be edited by the agent working
      // in it; these can't be, and restrictive rules can't be loosened.
      // The operator's deny list. `disallowedTools` is the mechanism that
      // actually enforces: it takes bare tool names ("Read") and Claude Code
      // rule patterns ("Bash(cat:*)"), both verified to refuse. managedSettings
      // looked like the right home for this and silently did nothing, so it
      // isn't used — a deny list that doesn't deny is worse than none.
      ...(permissions?.deny?.length ? { disallowedTools: permissions.deny } : {}),
      ...(mcp ? { mcpServers: { colinear: mcp } } : {}),
      ...(outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: outputSchema } } : {}),
      canUseTool: async (toolName, input) => {
        // our own tools post to a channel this agent is already a member of —
        // asking the operator per message would make coordination unusable
        if (toolName.startsWith(COLINEAR_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: input };
        if (toolName === 'AskUserQuestion') {
          const parsed = input as AskUserQuestionInput;
          // keep the whole set: up to four questions, each with option
          // descriptions. Answering one and dropping the rest just made the
          // agent ask the others again on its next turn.
          const questions: AskedQuestion[] = (parsed.questions ?? []).map((q) => ({
            header: q.header,
            text: q.question ?? '(no question text)',
            multiSelect: q.multiSelect,
            options: (q.options ?? [])
              .filter((o) => o.label)
              .map((o) => ({ label: o.label as string, description: o.description })),
          }));
          if (!questions.length) {
            questions.push({ text: JSON.stringify(input).slice(0, 300), options: [] });
          }
          const answers = await new Promise<string[]>((resolve) => {
            callbacks.onQuestion({ questions, kind: 'ask', answer: resolve });
          });
          const transcript = questions
            .map((q, i) => `Q: ${q.text}\nA: ${answers[i] ?? '(no answer)'}`)
            .join('\n\n');
          return {
            behavior: 'deny',
            message: `The user answered:\n\n${transcript}\n\nThis is not an error — continue working based on these answers, and do not ask these questions again.`,
            interrupt: false,
          };
        }
        // only reached when the auto-mode classifier blocked the call or
        // couldn't decide — ask the operator instead of rubber-stamping
        const [answer] = await new Promise<string[]>((resolve) => {
          callbacks.onQuestion({
            kind: 'permission',
            questions: [
              {
                header: toolName,
                text: `The agent wants to run ${toolName}: ${describeInput(input)}`,
                options: [
                  { label: 'allow', description: 'run it this once' },
                  { label: 'deny', description: 'refuse; the agent is told to find another way' },
                ],
              },
            ],
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

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const result: SessionResult = { text: '', costUsd: 0, isError: false, errors: [], assistantTurns: 0 };
  const registered = opts.agent ? startSession({ ...opts.agent, cwd, model }) : undefined;
  if (registered) opts.agent?.onRegistered?.(registered);

  try {
  for await (const msg of q) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          callbacks.onSessionId(msg.session_id);
          if (registered) updateSession(registered, { sessionId: msg.session_id });
        }
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
        if (usage) {
          totals.input += usage.input_tokens ?? 0;
          totals.output += usage.output_tokens ?? 0;
          totals.cacheRead += usage.cache_read_input_tokens ?? 0;
          totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;
        }
        for (const block of msg.message.content) {
          const line =
            block.type === 'text' && block.text.trim()
              ? firstLine(block.text)
              : block.type === 'tool_use'
                ? `⚒ ${block.name} ${summarizeInput(block.input)}`
                : undefined;
          if (!line) continue;
          callbacks.onActivity(line);
          if (registered) updateSession(registered, { activity: line });
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
        // a turn finished, so anything in flight landed in the conversation
        inbox?.markDelivered();
        // A streaming session doesn't end on its own: it waits for more input.
        // Close it now unless the operator got a message in first, in which
        // case the agent takes one more turn to deal with it.
        if (inbox && (result.isError || inbox.pending === 0)) inbox.close();
        break;
      }
      default:
        break;
    }
    if (registered) {
      updateSession(registered, {
        costUsd: result.costUsd,
        // the session's own totals, so the list agrees with the card
        tokens: totals,
      });
    }
  }

  if (registered) {
    endSession(registered, result.isError ? 'error' : 'done', {
      costUsd: result.costUsd,
      tokens: totals,
    });
  }
  return result;
  } catch (err) {
    // a throw here is still an ended session: leaving it "running" forever is
    // how a list of agents becomes a list of ghosts
    if (registered) endSession(registered, 'error', { activity: String(err).slice(0, 120) });
    throw err;
  }
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
