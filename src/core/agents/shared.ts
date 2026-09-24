import type { SessionChannels } from '../channel.js';
import type { CoordinatorTools } from '../coordinator.js';
import type { AgentKind } from '../sessions.js';
import type { PendingQuestion, SessionSpend } from '../types.js';

/**
 * What an agent runtime can do, asked rather than assumed.
 *
 * The same bargain `ProviderCapabilities` strikes with issue trackers, for the
 * same reason: the runtimes genuinely differ, and a feature built on something
 * one of them lacks has to switch off where the operator can see it rather
 * than fail at the moment they use it.
 *
 * These are not cosmetic. A runtime that cannot ask a question does not put a
 * task in `needs_input`, it guesses — so `questions: false` is a statement
 * about what the work will be like, not about which key is greyed out.
 */
export interface AgentCapabilities {
  /** the agent can stop and ask the operator → needs_input rather than a guess */
  questions: boolean;
  /** the operator can reach a live session (`M`); otherwise messages wait for the next one */
  messaging: boolean;
  /** a live session can be handed to a terminal (`s`) */
  attach: boolean;
  /** per-tool deny rules are enforced, rather than only a coarse sandbox mode */
  denyRules: boolean;
  /** runs come back priced, so spend can be shown in dollars rather than tokens */
  cost: boolean;
  /** output can be constrained to a caller-supplied JSON schema (triage, drafts) */
  structuredOutput: boolean;
  /** a conversation can be resumed by id */
  resume: boolean;
  /** colinear can mint the conversation id, so a headless session and an
      interactive terminal can share one conversation (the plan chat) */
  sharedSessionId: boolean;
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
  /** yielded to the runtime, but no turn has completed behind it yet */
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
   * Messages that may never have been read. The runtime pulls from the stream as
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

  /**
   * The prompt stream: the opening prompt, then whatever the operator sends.
   *
   * Plain strings — the envelope a runtime wants around them is the adapter's
   * business, and putting one runtime's message shape here is what would make
   * the mailbox unusable to any other.
   */
  async *stream(first: string): AsyncIterable<string> {
    yield first;
    while (!this.closed) {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.inFlight.push(next);
        // stamped here, not by the caller, so what drain() returns is the raw
        // text and a re-queued message can't collect a second prefix
        yield `Message from the operator: ${next}`;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
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
  /**
   * The ledger entry for this run: what it spent and what ran it.
   *
   * Reported from here because this is the only place that knows. The model
   * the caller asked for is not necessarily the one that answered — a session
   * whose model has no allowance left finishes on whatever it demoted to, and
   * that switch happens below every caller.
   */
  spend?: SessionSpend;
}

export interface RunSessionOpts {
  prompt: string;
  cwd: string;
  callbacks: SessionCallbacks;
  outputSchema?: Record<string, unknown>;
  model?: string;
  /** what to demote to if `model` is overloaded or out of allowance */
  fallbackModel?: string;
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
}

/**
 * One agent runtime, behind one interface.
 *
 * Everything above this file is runtime-agnostic and everything below it is
 * one adapter — the arrangement `core/provider.ts` already uses for trackers,
 * and for the same reason. Nothing outside `core/agents/` imports an agent
 * SDK, so "which runtime" stays a question asked in one place.
 */
export interface AgentBackend {
  readonly name: string;
  readonly capabilities: AgentCapabilities;
  /** what the model pickers offer; the config takes any string besides */
  readonly models: string[];
  runSession(opts: RunSessionOpts): Promise<SessionResult>;

  /** what must be on PATH for this runtime to work at all — `coli doctor` asks */
  readonly cli: { command: string; versionArgs: string[]; install: string };

  /**
   * Can this conversation be resumed from this directory?
   *
   * Asked of the runtime rather than of a stored id, because the two disagree
   * in ways that leave the operator stuck: an id minted for a session that
   * never started, or one created somewhere else entirely.
   */
  sessionExists(cwd: string, sessionId: string): boolean;

  /**
   * Where this runtime files a session's transcript, if it files them per
   * working directory. Undefined where it does not, which is a real answer
   * rather than a gap: backup has nothing per-directory to archive then.
   */
  transcriptDir(cwd: string): string | undefined;

  /**
   * argv for handing a session to the operator's terminal, or undefined where
   * `capabilities.attach` is false. `fresh` starts the named id rather than
   * resuming it, which only a runtime with `sharedSessionId` can do.
   */
  attachArgv(opts: {
    sessionId: string;
    permissionMode: string;
    fresh?: boolean;
    primer?: string;
  }): string[] | undefined;

  /** the command an operator would type to reach this session themselves, for the views */
  resumeHint(sessionId: string): string | undefined;
}
