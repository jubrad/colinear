import {
  createSdkMcpServer,
  query,
  tool,
  type PermissionMode,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { channels, formatMessages } from '../channel.js';
import { endSession, startSession, updateSession } from '../sessions.js';
import type { SessionChannels } from '../channel.js';
import type { CoordinatorTools } from '../coordinator.js';
import type { AskedQuestion, PlannedSubtask, SessionSpend } from '../types.js';
import type {
  AgentBackend,
  AgentCapabilities,
  RunSessionOpts,
  SessionResult,
} from './shared.js';

/**
 * Claude Code, through the agent SDK.
 *
 * Everything in this file is one runtime's business: the SDK import, the
 * question-as-a-denial hack, the fallback the SDK refuses, the wording Claude
 * Code uses when an allowance runs out. Nothing above `core/agent.ts` knows
 * any of it, which is the point — the same arrangement `providers/linear.ts`
 * has with trackers.
 *
 * Auth is the logged-in `claude` CLI and the subscription behind it.
 * `ANTHROPIC_API_KEY` must stay unset or the runs bill the API instead.
 */
export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // AskUserQuestion, answered back through a tool denial (see canUseTool)
  questions: true,
  // a streaming-input session stays open between turns, so `M` reaches it
  messaging: true,
  // `claude --resume <id>` hands the same conversation to a terminal
  attach: true,
  // `disallowedTools` takes bare names and rule patterns like `Bash(cat:*)`
  denyRules: true,
  // every result carries total_cost_usd
  cost: true,
  // outputFormat json_schema: triage verdicts and both draft flows need it
  structuredOutput: true,
  resume: true,
  // colinear mints the uuid and passes --session-id, so the plan chat is one
  // conversation shared between a headless session and the operator's terminal
  sharedSessionId: true,
};

/** What the pickers offer. The config still takes any string, including an exact id. */
export const CLAUDE_MODELS = ['sonnet', 'opus', 'fable', 'haiku'];

export function claudeBackend(): AgentBackend {
  return {
    name: 'claude',
    capabilities: CLAUDE_CAPABILITIES,
    models: CLAUDE_MODELS,
    runSession,
    cli: {
      command: 'claude',
      versionArgs: ['--version'],
      install: 'install Claude Code and run `claude login`',
    },
    sessionExists,
    transcriptDir,
    attachArgv: ({ sessionId, permissionMode, fresh, primer }) =>
      fresh
        ? ['--session-id', sessionId, '--permission-mode', permissionMode, ...(primer ? [primer] : [])]
        : ['--resume', sessionId, '--permission-mode', permissionMode],
    resumeHint: (sessionId) => `claude --resume ${sessionId}`,
  };
}

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


function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
}

/**
 * The mailbox yields plain strings; this is where they get this runtime's
 * envelope. Keeping the wrapping here is what lets `SessionInbox` be shared:
 * the queueing, the in-flight bookkeeping and the re-queue on a dead session
 * are the same problem whatever is reading the stream.
 */
async function* asUserMessages(texts: AsyncIterable<string>): AsyncIterable<SDKUserMessage> {
  for await (const text of texts) yield userMessage(text);
}


interface AskUserQuestionInput {
  questions?: Array<{
    question?: string;
    header?: string;
    multiSelect?: boolean;
    options?: Array<{ label?: string; description?: string }>;
  }>;
}

/**
 * What a session may actually demote to, given the model it runs on.
 *
 * The agent SDK does not treat a fallback equal to the primary as a no-op: it
 * throws `Fallback model cannot be the same as the main model`, before the
 * session starts. So an operator whose `fallbackModel` happened to match the
 * model they pinned — or a single task switched onto the fallback with `m` —
 * would not get a demotion, they would get every dispatch failing outright.
 * The primary is filtered out of the list here, in the one function that
 * builds the query, rather than at each call site.
 *
 * With no explicit model the session already runs on the default one, so
 * `"default"` names the primary just as surely as an id would, and passing it
 * would be a flag that can never fire.
 */
export function fallbackFor(model?: string, fallback?: string): string | undefined {
  if (!fallback) return undefined;
  const primary = model?.trim();
  const isPrimary = new Set(primary ? [primary] : ['default']);
  const rest = fallback
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name && !isPrimary.has(name));
  return rest.length ? rest.join(',') : undefined;
}

/**
 * A spent allowance, which is not the same thing as an overloaded model.
 *
 * The agent SDK's own `fallbackModel` does not cover this: it is documented
 * for a model that is overloaded or unavailable, and a monthly limit is
 * neither. Verified against a genuinely exhausted allowance — with and
 * without a fallback configured, Claude Code returns the identical error
 * result and never switches:
 *
 *     You've hit your monthly spend limit. Switch to another model to continue.
 *
 * So colinear has to do the switching. Waiting is not the remedy the way it
 * is for a 429, which is why this is kept apart from the dispatcher's
 * rate-limit retry: the allowance comes back next month, not in 30 seconds.
 */
export function outOfAllowance(err: unknown): boolean {
  const text = String(err);
  // An overload is the other thing entirely: it passes, so the remedy is to
  // wait (the dispatcher's 30s retry), not to spend the rest of the task on a
  // weaker model. Checked first because "rate limit reached" would otherwise
  // satisfy the allowance pattern below.
  if (/rate.?limit|overloaded|\b529\b/i.test(text)) return false;
  return /(spend|usage|quota) limit|limit reached|switch to another model/i.test(text);
}

/**
 * Run a session, demoting through the fallback chain if the model it is on
 * has nothing left in the allowance.
 *
 * This lives here rather than in the dispatcher because the dispatcher is not
 * the only thing that starts sessions — a pre-review, a review chat turn, an
 * annotated-diff explain and a self-review all come through here too, and a
 * limit that stops work stops all of them equally.
 */
export async function runSession(opts: RunSessionOpts): Promise<SessionResult> {
  const chain = (fallbackFor(opts.model, opts.fallbackModel) ?? '').split(',').filter(Boolean);
  let model = opts.model;
  for (let i = 0; ; i++) {
    try {
      return await runOne({ ...opts, model });
    } catch (err) {
      const next = chain[i];
      if (!next || !outOfAllowance(err)) throw err;
      opts.callbacks.onActivity(`${model ?? 'the default model'} is out of allowance — switching to ${next}`);
      model = next;
    }
  }
}

async function runOne(opts: RunSessionOpts): Promise<SessionResult> {
  const {
    prompt, cwd, callbacks, outputSchema, model, fallbackModel, maxTurns, resume, abortController,
    channels: membership, inbox, coordinator, permissions,
  } = opts;
  const mcp = colinearServer({ channels: membership, coordinator });

  const q = query({
    prompt: inbox ? asUserMessages(inbox.stream(prompt)) : prompt,
    options: {
      cwd,
      model,
      // the primary is retried at the start of each user turn, so an overload
      // or a spent allowance demotes the session without pinning it down there
      fallbackModel: fallbackFor(model, fallbackModel),
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

  const startedAt = Date.now();
  let observed: string[] | undefined;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // What has already been handed to `onUsage`. That callback is incremental —
  // every consumer adds what it is given — so reconciling it to an
  // authoritative figure means sending the difference, which can be negative.
  const reported = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // One assistant message can arrive as several frames sharing a message id,
  // one per content block, each carrying the same usage. Counting every frame
  // counts the message twice; measured, that inflated cache traffic exactly 2x.
  const counted = new Set<string>();
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
        // A live figure, and a rough one: a frame's usage is partial and says
        // nothing about auxiliary model calls. The `result` below reconciles
        // it against the runtime's own accounting, so this exists to make the
        // counter move during a turn rather than to be right.
        if (usage && !counted.has(msg.message.id)) {
          counted.add(msg.message.id);
          const live = {
            // mirror Claude Code's /cost split: cache traffic reported apart
            // from real input, or 40 cached turns read as millions of tokens
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
          };
          callbacks.onUsage?.(live);
          for (const key of Object.keys(live) as Array<keyof typeof live>) reported[key] += live[key];
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
        // `modelUsage` is the SDK's own account of every call this query made,
        // keyed by model, and is the authority on two things the assistant
        // frames cannot answer: which models actually ran — catching the SDK's
        // internal fallback for an overloaded model, and any subagent — and
        // how many tokens they used.
        //
        // Measured on one ordinary session asking for sonnet, the frames said
        // 8 input and 8 output tokens where the truth was 907 and 561, and
        // reported exactly double the cache traffic. Summing frames was wrong
        // three separate ways, so it is not summed any more.
        //
        // It is cumulative across the turns of a streaming session — each
        // result carries the running total — so it is assigned, never added,
        // the same way `total_cost_usd` is assigned above.
        const perModel = Object.entries(msg.modelUsage ?? {});
        if (perModel.length) {
          observed = perModel.map(([name]) => name);
          totals.input = 0;
          totals.output = 0;
          totals.cacheRead = 0;
          totals.cacheWrite = 0;
          for (const [, use] of perModel) {
            totals.input += use.inputTokens ?? 0;
            totals.output += use.outputTokens ?? 0;
            totals.cacheRead += use.cacheReadInputTokens ?? 0;
            totals.cacheWrite += use.cacheCreationInputTokens ?? 0;
          }
          if (callbacks.onUsage) {
            // consumers add, so hand them the correction rather than the total
            const delta = {
              input: totals.input - reported.input,
              output: totals.output - reported.output,
              cacheRead: totals.cacheRead - reported.cacheRead,
              cacheWrite: totals.cacheWrite - reported.cacheWrite,
            };
            if (Object.values(delta).some((n) => n !== 0)) callbacks.onUsage(delta);
            for (const key of Object.keys(delta) as Array<keyof typeof delta>) reported[key] += delta[key];
          }
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
  if (opts.agent) {
    result.spend = {
      kind: opts.agent.kind,
      runtime: 'claude',
      model,
      ...(observed ? { ran: observed } : {}),
      startedAt,
      endedAt: Date.now(),
      tokens: { ...totals },
      costUsd: result.costUsd,
    };
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

/**
 * Where Claude Code files a session's transcript.
 *
 * Transcripts are stored per working directory — `~/.claude/projects/<encoded
 * cwd>/<session>.jsonl` — which is why a resume only works from the directory
 * the conversation was started in. The encoding replaces every character that
 * isn't alphanumeric with a dash, so `/Users/x/.claude/y` becomes
 * `-Users-x--claude-y` (the dot collapses into a second dash).
 */
export function transcriptDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * Can this session actually be resumed from this directory?
 *
 * Asking the filesystem rather than trusting a stored id, because the two
 * disagree in ways that leave the operator stuck: an id minted for a session
 * that never started, or one created somewhere else entirely. `claude
 * --resume` answers both with "session doesn't exist" and no way forward.
 */
export function sessionExists(cwd: string, sessionId: string): boolean {
  return existsSync(join(transcriptDir(cwd), `${sessionId}.jsonl`));
}
