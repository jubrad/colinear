import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  /** which conversation this is — the history lists them by it */
  id: string;
  messages: AskMessage[];
  busy: boolean;
  /** the agent's latest step while busy — a tool call, a line of thinking */
  activity?: string;
  /** messages typed while it was busy, answered in turn */
  queued: number;
}

/** A conversation as kept on disk: every message, and the session that resumes it. */
export interface AskConversation {
  id: string;
  startedAt: number;
  updatedAt: number;
  /** the agent session behind it — opening it again resumes this */
  sessionId?: string;
  messages: AskMessage[];
}

/** One line of the history: enough to recognise a conversation and open it. */
export interface AskSummary {
  id: string;
  /** the first thing you asked */
  title: string;
  startedAt: number;
  updatedAt: number;
  count: number;
}

const newId = () => `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Where conversations are kept: one JSON file each, under the state dir —
 * so they outlive the TUI and the daemon both, and the history is a listing.
 */
export class AskStore {
  constructor(private dir: string) {}

  private path(id: string): string {
    return join(this.dir, `${id.replace(/[^\w-]/g, '')}.json`);
  }

  save(c: AskConversation): void {
    // a conversation nothing was said in is not history
    if (!c.messages.length) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(c.id), JSON.stringify(c));
  }

  load(id: string): AskConversation | undefined {
    try {
      return JSON.parse(readFileSync(this.path(id), 'utf8')) as AskConversation;
    } catch {
      return undefined;
    }
  }

  /** newest first */
  list(): AskSummary[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    return files
      .map((f) => this.load(f.replace(/\.json$/, '')))
      .filter((c): c is AskConversation => Boolean(c?.messages?.length))
      .map((c) => ({
        id: c.id,
        title: (c.messages.find((m) => m.from === 'you')?.text ?? '').replace(/\s+/g, ' ').slice(0, 200),
        startedAt: c.startedAt,
        updatedAt: c.updatedAt,
        count: c.messages.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
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
  private conv: AskConversation;
  private busy = false;
  private activity?: string;
  private pending: Array<{ conv: string; text: string }> = [];
  private abort?: AbortController;
  private store: AskStore;
  onChange?: (state: AskState) => void;

  constructor(
    private cfg: Config,
    /** starts a review the way `r` does — importing a repo you have not got */
    private start: (id: string, opts?: { instructions?: string }) => void,
    dir = join(STATE_DIR, 'ask', 'conversations'),
  ) {
    this.store = new AskStore(dir);
    // a restart picks up where you were: the newest conversation stays current
    const last = this.store.list()[0];
    this.conv = (last && this.store.load(last.id)) || this.blank();
  }

  private blank(): AskConversation {
    return { id: newId(), startedAt: Date.now(), updatedAt: Date.now(), messages: [] };
  }

  get(): AskState {
    return {
      id: this.conv.id,
      messages: this.conv.messages,
      busy: this.busy,
      activity: this.activity,
      queued: this.pending.length,
    };
  }

  /** every saved conversation, newest first */
  history(): AskSummary[] {
    return this.store.list();
  }

  send(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.append(this.conv.id, { from: 'you', text: t, at: Date.now() });
    this.pending.push({ conv: this.conv.id, text: t });
    this.changed();
    if (!this.busy) void this.drain();
  }

  /** a new conversation; the one before stays in the history */
  reset(): void {
    this.cancel();
    this.conv = this.blank();
    this.changed();
  }

  /** bring a past conversation back: its messages, and its session to resume */
  open(id: string): boolean {
    if (id === this.conv.id) return true;
    const found = this.store.load(id);
    if (!found) return false;
    this.cancel();
    this.conv = found;
    this.changed();
    return true;
  }

  /** stop what it is doing now; what was queued is dropped too */
  cancel(): void {
    this.pending = [];
    this.abort?.abort();
  }

  private changed(): void {
    this.onChange?.(this.get());
  }

  /** a message onto its own conversation — the current one, or one you have since left */
  private append(id: string, m: AskMessage): void {
    const conv = id === this.conv.id ? this.conv : this.store.load(id);
    if (!conv) return;
    conv.messages = [...conv.messages, m].slice(-KEEP);
    conv.updatedAt = m.at;
    this.store.save(conv);
  }

  private async drain(): Promise<void> {
    this.busy = true;
    while (this.pending.length) {
      const next = this.pending.shift()!;
      this.activity = 'thinking…';
      this.changed();
      const reply = await this.turn(next.conv, next.text);
      // the reply goes where the question was asked, even if you have moved on
      this.append(next.conv, { from: 'colinear', text: reply, at: Date.now() });
      this.changed();
    }
    this.busy = false;
    this.activity = undefined;
    this.changed();
  }

  private async turn(convId: string, text: string): Promise<string> {
    // the colinear tools are an MCP server only Claude Code's adapter builds
    const backend = agentNamed(this.cfg, 'claude');
    const cwd = join(STATE_DIR, 'ask');
    mkdirSync(cwd, { recursive: true });
    const controller = new AbortController();
    this.abort = controller;
    // each conversation resumes its own session
    const conv = convId === this.conv.id ? this.conv : this.store.load(convId);
    const sessionId = conv?.sessionId;
    try {
      const result = await backend.runSession({
        prompt: sessionId ? text : `${PREFACE}\n\n---\n\n${text}`,
        cwd,
        resume: sessionId,
        permissions: { mode: this.cfg.agentPermissionMode, deny: [...this.cfg.denyTools, 'Edit', 'Write', 'NotebookEdit'] },
        agent: { kind: 'ask', label: 'ask colinear', origin: 'you, in the @ chat' },
        callbacks: {
          onActivity: (line) => {
            this.activity = line;
            this.changed();
          },
          onSessionId: (id) => {
            const target = convId === this.conv.id ? this.conv : this.store.load(convId);
            if (!target) return;
            target.sessionId = id;
            this.store.save(target);
          },
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
