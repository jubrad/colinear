import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentCapabilities, RunSessionOpts, SessionResult } from './shared.js';
import { endSession, startSession, updateSession } from '../sessions.js';

/**
 * OpenAI Codex, through `@openai/codex-sdk`.
 *
 * The SDK is a wrapper around `codex exec --json`: prompt in, events out. That
 * shapes everything below, and it is why several capabilities are false rather
 * than merely unimplemented. Approval callbacks, ask-the-user and host-provided
 * in-process tools are not missing from this adapter — `codex exec` *rejects*
 * them, answering each server request with "not supported in exec mode". The
 * rich surface for those is `codex app-server`, an experimental JSON-RPC
 * protocol with no published client; if colinear ever needs per-command
 * approval from Codex, that is the door, not this one.
 *
 * Auth is the logged-in `codex` CLI and the ChatGPT plan behind it. The SDK's
 * `apiKey` option sets `CODEX_API_KEY` on the child and silently switches to
 * metered API billing, so it is deliberately never set — the same rule
 * colinear already has about `ANTHROPIC_API_KEY`.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Codex can ask — interactively, and over app-server. What it cannot do is
  // ask through `codex exec`, which answers `request_user_input` with "not
  // supported in exec mode". So the adapter supplies the mechanism instead of
  // the runtime: the agent is told to end its turn with a sentinel, and that
  // becomes a real question (see ASK_PREAMBLE and askedIn).
  questions: true,
  // a thread takes consecutive turns, so an operator message becomes the next
  // one — which is exactly colinear's delivery promise, "at the next turn"
  messaging: true,
  // `codex resume <id>` opens the same conversation interactively
  attach: true,
  // sandbox modes only: read-only, workspace-write, danger-full-access. There
  // is nothing that takes a rule like `Bash(git push --force:*)`.
  denyRules: false,
  // usage is reported in tokens; no run comes back with a price
  cost: false,
  structuredOutput: true,
  resume: true,
  // Codex mints the thread id itself, so colinear cannot hand one to a fresh
  // session the way the plan chat does with Claude Code
  sharedSessionId: false,
};

/** What the picker offers. `codex debug models` lists what a given build knows. */
export const CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra'];

/**
 * How an agent with no ask-the-user tool asks anyway.
 *
 * Colinear's prompts tell agents to use `AskUserQuestion`, which is Claude
 * Code's built-in. Codex has no such tool over exec, so rather than rewrite
 * every prompt per runtime, the adapter translates: it tells the agent what
 * that instruction means here. Translating colinear's vocabulary into the
 * runtime's reality is the adapter's whole job.
 *
 * A sentinel rather than a tool because exec gives us one channel back — the
 * assistant message — and a turn that ends with it is unambiguous.
 */
const ASK_SENTINEL = 'NEEDS INPUT:';

const ASK_PREAMBLE = [
  'You have no AskUserQuestion tool in this environment.',
  `If anything below tells you to use AskUserQuestion, or you are blocked on a decision only a human can make, stop and make your ENTIRE final message \`${ASK_SENTINEL} <your question>\`.`,
  'Ask only when you genuinely cannot proceed: you will be answered and the conversation will continue from there. Never use that prefix for anything else.',
  '',
].join('\n');

/** The question in a turn that ended by asking one, or nothing if it did not. */
export function askedIn(text: string): string | undefined {
  const at = text.indexOf(ASK_SENTINEL);
  if (at === -1) return undefined;
  // only a turn that *ends* on the sentinel is asking; a mention mid-answer is
  // the agent talking about the convention rather than using it
  const question = text.slice(at + ASK_SENTINEL.length).trim();
  return question || undefined;
}

/** Where Codex files its rollouts: by date, not by working directory. */
function sessionsRoot(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
}

/**
 * Codex files rollouts under `sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`,
 * so a session is not addressed by the directory it ran in and `cwd` has no
 * part in finding one. The walk is bounded by that fixed year/month/day shape
 * rather than being a general recursive search.
 */
function findRollout(sessionId: string): string | undefined {
  const root = sessionsRoot();
  if (!sessionId || !existsSync(root)) return undefined;
  const dirs = (at: string) => {
    try {
      return readdirSync(at, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(at, e.name));
    } catch {
      return [];
    }
  };
  for (const year of dirs(root)) {
    for (const month of dirs(year)) {
      for (const day of dirs(month)) {
        try {
          const hit = readdirSync(day).find((f) => f.endsWith(`${sessionId}.jsonl`));
          if (hit) return join(day, hit);
        } catch {
          /* a directory that vanished mid-walk is not a match */
        }
      }
    }
  }
  return undefined;
}

/** One line for the card, in the same shape Claude Code's activity takes. */
function activityFor(item: { type: string; [k: string]: unknown }): string | undefined {
  switch (item.type) {
    case 'agent_message':
      return String(item.text ?? '').trim().split('\n')[0].slice(0, 120) || undefined;
    case 'command_execution':
      return `⚒ Bash ${String(item.command ?? '').slice(0, 100)}`;
    case 'file_change': {
      const changes = (item.changes as Array<{ path: string; kind: string }> | undefined) ?? [];
      const names = changes.map((c) => `${c.kind} ${c.path}`).join(', ');
      return `⚒ Edit ${names.slice(0, 100)}`;
    }
    case 'mcp_tool_call':
      return `⚒ ${String(item.server ?? '')}.${String(item.tool ?? '')}`;
    case 'web_search':
      return '⚒ WebSearch';
    case 'error':
      // A non-fatal note, not a failed turn: Codex uses an error *item* for
      // things like an unrecognized key in the operator's own config.toml,
      // while a turn that actually failed arrives as `turn.failed`. Prefixed
      // so a config warning does not read as a dead session.
      return `⚠ ${String(item.message ?? '').split('\n')[0].slice(0, 120)}`;
    default:
      // reasoning and todo_list are noise on a one-line card
      return undefined;
  }
}

export function codexBackend(): AgentBackend {
  return {
    name: 'codex',
    capabilities: CODEX_CAPABILITIES,
    models: CODEX_MODELS,
    runSession,
    cli: {
      command: 'codex',
      versionArgs: ['--version'],
      install: 'install the Codex CLI and run `codex login`',
    },
    // cwd is ignored on purpose: Codex does not file by directory, so a
    // session started anywhere is resumable from anywhere
    sessionExists: (_cwd, sessionId) => findRollout(sessionId) !== undefined,
    transcriptDir: () => undefined,
    attachArgv: ({ sessionId }) => ['resume', sessionId],
    resumeHint: (sessionId) => `codex resume ${sessionId}`,
  };
}

async function runSession(opts: RunSessionOpts): Promise<SessionResult> {
  const { prompt, cwd, callbacks, outputSchema, model, resume, abortController, inbox } = opts;
  // Loaded here rather than at module scope so an operator who only ever runs
  // Claude never pays for it, the way the sqlite provider defers node:sqlite.
  const { Codex } = await import('@openai/codex-sdk');

  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const result: SessionResult = { text: '', costUsd: 0, isError: false, errors: [], assistantTurns: 0 };
  const startedAt = Date.now();
  const registered = opts.agent ? startSession({ ...opts.agent, cwd, model }) : undefined;
  if (registered) opts.agent?.onRegistered?.(registered);

  try {
    const codex = new Codex({});
    const threadOptions = {
      ...(model ? { model } : {}),
      workingDirectory: cwd,
      // colinear owns the worktree and hands it over; Codex must not cut one
      // of its own, and a worktree is a git repo so the check is satisfied
      skipGitRepoCheck: true,
      // the agent is expected to edit the worktree it was given and nothing else
      sandboxMode: 'workspace-write' as const,
      // exec mode rejects approval requests anyway; asking for them would only
      // produce a turn that fails on the first command
      approvalPolicy: 'never' as const,
      networkAccessEnabled: true,
    };
    const thread = resume ? codex.resumeThread(resume, threadOptions) : codex.startThread(threadOptions);

    /** One turn: everything Codex emits while it works on a single prompt. */
    const runTurn = async (input: string): Promise<void> => {
      const turn = await thread.runStreamed(input, {
        ...(outputSchema ? { outputSchema } : {}),
        ...(abortController ? { signal: abortController.signal } : {}),
      });
      for await (const event of turn.events) {
        switch (event.type) {
          case 'thread.started':
            callbacks.onSessionId(event.thread_id);
            if (registered) updateSession(registered, { sessionId: event.thread_id });
            break;
          case 'item.completed': {
            const item = event.item as { type: string; text?: string } & Record<string, unknown>;
            if (item.type === 'agent_message') {
              result.assistantTurns++;
              result.text = String(item.text ?? '');
            }
            const line = activityFor(item);
            if (line) {
              callbacks.onActivity(line);
              if (registered) updateSession(registered, { activity: line });
            }
            break;
          }
          case 'turn.completed': {
            // Codex reports per-turn usage, so this accumulates — unlike the
            // Claude adapter, where the figure is cumulative and is assigned
            const u = event.usage;
            const live = {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cached_input_tokens ?? 0,
              cacheWrite: u.cache_write_input_tokens ?? 0,
            };
            callbacks.onUsage?.(live);
            for (const key of Object.keys(live) as Array<keyof typeof live>) totals[key] += live[key];
            break;
          }
          case 'turn.failed':
            result.isError = true;
            result.errors.push(String(event.error?.message ?? 'turn failed'));
            break;
          case 'error':
            result.isError = true;
            result.errors.push(String(event.message ?? 'codex error'));
            break;
          default:
            break;
        }
      }
    };

    /**
     * A turn that ended by asking. The operator's answer becomes the next turn,
     * which is the same shape a message takes — Codex has one way in, and a
     * question is just a turn colinear started rather than the operator.
     */
    const answerIfAsked = async (): Promise<boolean> => {
      const question = askedIn(result.text);
      if (!question) return false;
      const answer = await new Promise<string>((resolve) => {
        callbacks.onQuestion({
          kind: 'ask',
          questions: [{ text: question, options: [] }],
          answer: (answers) => resolve(answers[0] ?? ''),
        });
      });
      await runTurn(answer.trim() || 'Use your best judgement and say what you assumed.');
      return true;
    };

    // Bounded, because an agent that re-asks after every answer would otherwise
    // loop forever on the operator's attention rather than on tokens.
    const MAX_ASKS = 8;
    const settle = async (): Promise<void> => {
      for (let i = 0; i < MAX_ASKS; i++) if (!(await answerIfAsked())) return;
    };

    if (inbox) {
      // The mailbox drives the turns: its first yield is the opening prompt and
      // each later one is an operator message, which becomes the next turn.
      // That is colinear's delivery promise already — at the next turn boundary
      // — rather than an approximation of it.
      let opening = true;
      for await (const text of inbox.stream(prompt)) {
        await runTurn(opening ? ASK_PREAMBLE + text : text);
        opening = false;
        await settle();
        inbox.markDelivered();
        if (result.isError || inbox.pending === 0) inbox.close();
      }
    } else {
      await runTurn(ASK_PREAMBLE + prompt);
      await settle();
    }

    if (outputSchema && result.text.trim()) {
      try {
        result.structured = JSON.parse(result.text);
      } catch {
        // a schema was asked for and something else came back: the caller
        // checks `structured`, and a parse failure is not worth a throw
        result.errors.push('structured output did not parse as JSON');
      }
    }

    if (registered) endSession(registered, result.isError ? 'error' : 'done', { tokens: totals });
    if (opts.agent) {
      result.spend = {
        kind: opts.agent.kind,
        runtime: 'codex',
        model,
        ...(model ? { ran: [model] } : {}),
        startedAt,
        endedAt: Date.now(),
        tokens: { ...totals },
        // deliberately absent: Codex reports tokens and never a price, and
        // writing 0 here would be counted as a run that cost nothing
      };
    }
    return result;
  } catch (err) {
    if (registered) endSession(registered, 'error', { activity: String(err).slice(0, 120) });
    throw err;
  }
}
