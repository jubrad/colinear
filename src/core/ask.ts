import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentNamed } from './agent.js';
import { log, STATE_DIR } from './log.js';
import { modelsFor } from './models.js';
import { adoptReview, parsePrSpec, reviewId } from './reviews.js';
import { store } from './store.js';
import type { Config, Review } from './types.js';

/**
 * What the `@` chat's agent may do through colinear. Reading anything, and
 * the review actions that stay local — adding a PR to the list and starting
 * colinear's pre-review of it. Nothing here posts to GitHub or the tracker:
 * approving and commenting stay keys the operator presses.
 */
export interface AskTools {
  listReviews(filter?: string): string;
  listTasks(filter?: string): string;
  reviewStatus(pr: string): string;
  addReview(pr: string): Promise<string>;
  startReview(pr: string, instructions?: string): Promise<string>;
}

export interface AskMessage {
  from: 'you' | 'colinear';
  text: string;
  at: number;
}

/** What a client draws: the conversation, and what the agent is doing right now. */
export interface AskState {
  messages: AskMessage[];
  busy: boolean;
  /** the agent's latest step while busy — a tool call, a line of thinking */
  activity?: string;
  /** messages typed while it was busy, answered in turn */
  queued: number;
}

const KEEP = 200;

const PREFACE = `You are colinear's assistant, in a chat with the operator who runs colinear: a terminal tool that dispatches coding agents to issues and runs local pre-reviews of pull requests.

You act on their behalf through the colinear tools: list_reviews, list_tasks, review_status, add_review (put a PR on colinear's review list) and start_review (start colinear's local pre-review of a PR; it runs in the background, so start several and report back rather than waiting). You also have a shell with the GitHub CLI, \`gh\`, for finding things — PRs in a stack (follow each PR's base branch: \`gh pr view <n> -R owner/repo --json baseRefName,headRefName\`, \`gh pr list -R owner/repo --head <branch>\`), a PR's details, a search.

Nothing you do may reach GitHub or the tracker as the operator: do not comment, review, approve, merge, push, or edit issues — colinear's own keys do that, when the operator presses them. Do not edit files.

Keep replies short. Say what you did, as a list when it is a list (each PR as owner/repo#123), and anything you could not do and why. If you need something from the operator, ask it at the end of your reply; they will answer in their next message.`;

/**
 * The `@` chat: one conversation with an agent that can run colinear. It
 * lives in the daemon, so it survives the TUI closing; each message resumes
 * the same session, so "and the next one" means something. Messages typed
 * while it is working wait their turn rather than interrupting it.
 */
export class AskChat {
  private state: AskState = { messages: [], busy: false, queued: 0 };
  private pending: string[] = [];
  private sessionId?: string;
  private abort?: AbortController;
  onChange?: (state: AskState) => void;

  constructor(
    private cfg: Config,
    /** starts a review the way `r` does — importing a repo you have not got */
    private start: (id: string, opts?: { instructions?: string }) => void,
  ) {}

  get(): AskState {
    return this.state;
  }

  send(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.push({ from: 'you', text: t, at: Date.now() });
    this.pending.push(t);
    this.set({ queued: this.state.busy ? this.pending.length : 0 });
    if (!this.state.busy) void this.drain();
  }

  /** a fresh conversation: the history and the session behind it go */
  reset(): void {
    this.abort?.abort();
    this.pending = [];
    this.sessionId = undefined;
    this.state = { messages: [], busy: false, queued: 0 };
    this.onChange?.(this.state);
  }

  /** stop what it is doing now; what was queued is dropped too */
  cancel(): void {
    this.pending = [];
    this.abort?.abort();
  }

  private set(patch: Partial<AskState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange?.(this.state);
  }

  private push(m: AskMessage): void {
    this.set({ messages: [...this.state.messages, m].slice(-KEEP) });
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const text = this.pending.shift()!;
      this.set({ busy: true, activity: 'thinking…', queued: this.pending.length });
      const reply = await this.turn(text);
      this.push({ from: 'colinear', text: reply, at: Date.now() });
    }
    this.set({ busy: false, activity: undefined, queued: 0 });
  }

  private async turn(text: string): Promise<string> {
    // the colinear tools are an MCP server only Claude Code's adapter builds
    const backend = agentNamed(this.cfg, 'claude');
    const cwd = join(STATE_DIR, 'ask');
    mkdirSync(cwd, { recursive: true });
    const controller = new AbortController();
    this.abort = controller;
    try {
      const result = await backend.runSession({
        prompt: this.sessionId ? text : `${PREFACE}\n\n---\n\n${text}`,
        cwd,
        resume: this.sessionId,
        permissions: { mode: this.cfg.agentPermissionMode, deny: [...this.cfg.denyTools, 'Edit', 'Write', 'NotebookEdit'] },
        agent: { kind: 'ask', label: 'ask colinear', origin: 'you, in the @ chat' },
        callbacks: {
          onActivity: (line) => this.set({ activity: line }),
          onSessionId: (id) => (this.sessionId = id),
          // the operator is right there, but not inside this turn: ask in the reply
          onQuestion: (q) => q.answer(q.questions.map(() => 'Ask this at the end of your reply instead; the operator answers in their next message.')),
        },
        askTools: this.tools(),
        ...modelsFor(this.cfg, 'general'),
        maxTurns: 80,
        abortController: controller,
      });
      if (controller.signal.aborted) return '(stopped)';
      if (result.isError) return `something went wrong: ${result.errors.join('; ').slice(0, 300) || 'the session failed'}`;
      return result.text.trim() || '(no reply)';
    } catch (err) {
      log(`ask: ${String(err).slice(0, 200)}`);
      return controller.signal.aborted ? '(stopped)' : `something went wrong: ${String((err as Error)?.message ?? err).slice(0, 300)}`;
    } finally {
      this.abort = undefined;
    }
  }

  private tools(): AskTools {
    const target = (spec: string) => {
      const pr = parsePrSpec(spec);
      return pr ? { id: reviewId(pr.repository, pr.number), label: `${pr.repository}#${pr.number}` } : undefined;
    };
    const line = (r: Review) =>
      `${r.repository}#${r.number} · ${r.status}${r.task ? ` · task ${r.task}` : ''}${r.isDraft ? ' · draft' : ''} · ${r.title}`;
    const matches = (hay: string, filter?: string) => !filter || hay.toLowerCase().includes(filter.toLowerCase());
    return {
      listReviews: (filter) => {
        const rows = store.listReviews().filter((r) => r.status !== 'stale' && matches(line(r), filter));
        return rows.length ? rows.map(line).join('\n') : 'no reviews match';
      },
      listTasks: (filter) => {
        const rows = store
          .list()
          .map((t) => `${t.issue.identifier} · ${t.status}${t.prs[0] ? ` · PR ${t.prs[0].url}` : ''} · ${t.issue.title}`)
          .filter((l) => matches(l, filter));
        return rows.length ? rows.join('\n') : 'no tasks match';
      },
      reviewStatus: (spec) => {
        const t = target(spec);
        if (!t) return `${spec} is not a pull request — use owner/repo#123 or its URL`;
        const r = store.getReview(t.id);
        if (!r) return `${t.label} is not on colinear's review list — add_review puts it there`;
        const findings = r.findings ?? [];
        return [line(r), r.summary ? r.summary.trim().slice(0, 1500) : '', `${findings.length} finding(s)`, ...findings.map((f) => `- [${f.severity ?? 'lead'}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.comment.split('\n')[0]}`)]
          .filter(Boolean)
          .join('\n');
      },
      addReview: async (spec) => {
        const t = target(spec);
        if (!t) return `${spec} is not a pull request — use owner/repo#123 or its URL`;
        try {
          const r = await adoptReview(this.cfg, spec);
          return `${t.label} is on the review list (${r.status})`;
        } catch (err) {
          return String((err as Error)?.message ?? err).slice(0, 300);
        }
      },
      startReview: async (spec, instructions) => {
        const t = target(spec);
        if (!t) return `${spec} is not a pull request — use owner/repo#123 or its URL`;
        let r: Review;
        try {
          r = await adoptReview(this.cfg, spec);
        } catch (err) {
          return String((err as Error)?.message ?? err).slice(0, 300);
        }
        if (['reviewing', 'queued', 'posting'].includes(r.status)) return `${t.label} is already ${r.status}`;
        // in the background: a review takes minutes, and the point is to start several
        this.start(t.id, instructions ? { instructions } : undefined);
        return r.repo
          ? `started colinear's review of ${t.label} — it shows in :reviews`
          : `${t.label}'s repo is not configured yet: colinear is cloning it and adding it to the repos, then the review starts — it shows in :reviews`;
      },
    };
  }
}
