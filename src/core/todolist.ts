import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runtimeFor } from './agent.js';
import { isDemo } from './demo.js';
import { STATE_DIR, log } from './log.js';
import { modelsFor } from './models.js';
import { providerFor } from './provider.js';
import { pollReviewRequests } from './reviews.js';
import { store } from './store.js';
import { TODO_SCHEMA, applyRanking, buildCandidates, parseAnswer, rankPrompt } from './todo.js';
import type { Config, Issue, Project } from './types.js';

/**
 * The :todo list's daemon half: gather what might need the operator, land
 * colinear's own order at once, then ask an agent to order it properly.
 *
 * Two answers on purpose. The scored list is on screen within a second or
 * two of `r`, and it is what stays when the agent fails — a ranking pass that
 * errors should cost the operator the ranking, not the list.
 *
 * Read-only throughout: gathering reads the tracker and GitHub, the agent is
 * denied every tool that writes, and nothing it says reaches either service.
 */
export class TodoManager {
  onToast?: (text: string, kind: 'info' | 'ok' | 'err') => void;
  private abort?: AbortController;
  private busy = false;
  private clock?: NodeJS.Timeout;

  constructor(private cfg: Config) {}

  /** Start (or restart, after a config reload) the optional refresh clock. */
  startClock(): void {
    clearInterval(this.clock);
    this.clock = undefined;
    const minutes = this.cfg.todo.refreshMinutes;
    if (!this.cfg.todo.enabled || !minutes || isDemo(this.cfg)) return;
    this.clock = setInterval(() => void this.refresh({ agent: true, origin: `every ${minutes}m` }), minutes * 60_000);
  }

  shutdown(): void {
    clearInterval(this.clock);
    this.abort?.abort();
  }

  cancel(): void {
    if (!this.abort) return;
    this.abort.abort();
    store.addTodoActivity('ranking cancelled — keeping colinear\'s own order');
  }

  async refresh(opts: { agent: boolean; origin: string }): Promise<void> {
    // checked here rather than only in the view: a client older or newer than
    // this daemon's config must not be able to start a ranking session
    if (!this.cfg.todo.enabled) {
      this.onToast?.('todo is switched off — set "todo": { "enabled": true } in the config', 'err');
      return;
    }
    if (this.busy) {
      this.onToast?.('todo: already refreshing', 'info');
      return;
    }
    this.busy = true;
    try {
      await this.run(opts);
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }

  private async run({ agent, origin }: { agent: boolean; origin: string }): Promise<void> {
    const cfg = this.cfg;
    store.updateTodo({ status: 'gathering', origin, error: undefined });
    store.addTodoActivity(`${origin}: gathering`);

    const gathered = await this.gather();
    const now = Date.now();
    const all = buildCandidates({
      tasks: store.list(),
      reviews: store.listReviews(),
      issues: gathered.issues,
      projects: gathered.projects,
      viewerName: gathered.viewerName,
      now,
      cfg: cfg.todo,
      ciAutofix: cfg.ciAutofix,
    });
    const candidates = all.slice(0, cfg.todo.maxCandidates);
    const partial = gathered.errors.length ? gathered.errors.join('; ') : undefined;

    // colinear's order lands first: something to act on while the agent reads
    const ranking = agent && candidates.length > 0 && !isDemo(cfg);
    store.updateTodo({
      status: ranking ? 'ranking' : 'ready',
      items: candidates,
      considered: all.length,
      rankedBy: 'baseline',
      summary: undefined,
      generatedAt: now,
      error: partial,
    });
    store.addTodoActivity(
      `${all.length} candidate${all.length === 1 ? '' : 's'}` +
        (all.length > candidates.length ? ` (the top ${candidates.length} go to the agent)` : '') +
        (partial ? ` — ${partial}` : ''),
    );
    if (!ranking) {
      if (agent && isDemo(cfg)) store.addTodoActivity('demo mode: no agent, colinear\'s own order');
      return;
    }

    this.abort = new AbortController();
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    try {
      const result = await runtimeFor(cfg, 'todo').backend.runSession({
        // it has everything in the prompt; nothing it could run would help,
        // and a ranking pass has no business touching a file
        permissions: {
          mode: cfg.agentPermissionMode,
          deny: [...cfg.denyTools, 'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
        },
        agent: { kind: 'todo', label: 'todo list', origin },
        prompt: rankPrompt(cfg.todo, candidates, now, gathered.viewerName),
        cwd: todoCwd(),
        callbacks: {
          onActivity: (line) => store.addTodoActivity(line),
          onSessionId: () => {},
          // it was told not to ask; if it does anyway, don't park the list on it
          onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment')),
          onUsage: (u) => {
            tokens.input += u.input;
            tokens.output += u.output;
            tokens.cacheRead += u.cacheRead;
            tokens.cacheWrite += u.cacheWrite;
          },
        },
        outputSchema: TODO_SCHEMA,
        ...modelsFor(cfg, 'todo'),
        maxTurns: 4,
        abortController: this.abort,
      });
      if (result.spend) store.addTodoSpend(result.spend);
      const prior = store.todo?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const tokenPatch = {
        tokens: {
          input: prior.input + tokens.input,
          output: prior.output + tokens.output,
          cacheRead: prior.cacheRead + tokens.cacheRead,
          cacheWrite: prior.cacheWrite + tokens.cacheWrite,
        },
      };
      if (this.abort.signal.aborted) {
        store.updateTodo({ status: 'ready', ...tokenPatch });
        return;
      }
      const answer = result.isError ? undefined : parseAnswer(result.structured, result.text);
      if (!answer) {
        const why = result.errors.join('; ') || 'no answer in the shape asked for';
        store.updateTodo({ status: 'ready', error: `ranking failed (${why.slice(0, 160)}) — colinear's own order`, ...tokenPatch });
        log(`todo: ranking failed: ${why}`);
        return;
      }
      const { items, unknown } = applyRanking(candidates, answer);
      store.updateTodo({
        status: 'ready',
        items,
        rankedBy: 'agent',
        summary: answer.summary?.trim() || undefined,
        generatedAt: Date.now(),
        error: partial,
        ...tokenPatch,
      });
      store.addTodoActivity(
        `ranked ${items.length} of ${candidates.length}` + (unknown ? ` · dropped ${unknown} unknown key${unknown === 1 ? '' : 's'}` : ''),
      );
      this.onToast?.(`todo: ${items.length} things, in order`, 'ok');
    } catch (err) {
      const aborted = this.abort?.signal.aborted;
      store.updateTodo({
        status: 'ready',
        ...(aborted ? {} : { error: `ranking failed (${String(err).slice(0, 160)}) — colinear's own order` }),
      });
      if (!aborted) log(`todo: ranking threw: ${err}`);
    }
  }

  /**
   * What the list is made from. Each source can fail on its own — a Linear
   * outage should still leave you your reviews — and a failure is reported on
   * the list rather than swallowed, because a short list and a complete one
   * look the same.
   */
  private async gather(): Promise<{ issues: Issue[]; projects: Project[]; viewerName?: string; errors: string[] }> {
    const cfg = this.cfg;
    const provider = providerFor(cfg);
    const errors: string[] = [];
    // reviews are otherwise only as fresh as the 5-minute poll
    const reviewPoll = isDemo(cfg) ? Promise.resolve() : pollReviewRequests(cfg);
    const [issues, projects, viewer] = await Promise.allSettled([
      provider.issues(undefined, { includeProjects: true }),
      provider.capabilities.projects ? provider.projects() : Promise.resolve([] as Project[]),
      provider.viewer(),
      reviewPoll,
    ]);
    const issueErr = issues.status === 'rejected' ? brief(issues.reason) : undefined;
    const projectErr = projects.status === 'rejected' ? brief(projects.reason) : undefined;
    if (issueErr && issueErr === projectErr) errors.push(`could not read your issues or projects: ${issueErr}`);
    else {
      if (issueErr) errors.push(`could not read your issues: ${issueErr}`);
      if (projectErr) errors.push(`could not read projects: ${projectErr}`);
    }
    if (issueErr || projectErr) log(`todo: gather: ${String(issues.status === 'rejected' ? issues.reason : '')} ${String(projects.status === 'rejected' ? projects.reason : '')}`);
    return {
      issues: issues.status === 'fulfilled' ? issues.value : [],
      projects: projects.status === 'fulfilled' ? projects.value : [],
      viewerName: viewer.status === 'fulfilled' ? viewer.value.displayName : undefined,
      errors,
    };
  }
}

/**
 * An error as one short clause: "Linear API 401", not the response body a
 * provider error carries. The whole thing goes to the log.
 */
function brief(err: unknown): string {
  const text = String((err as Error)?.message ?? err).replace(/^Error:\s*/, '');
  const cut = text.search(/:\s*[{[]/);
  return (cut === -1 ? text : text.slice(0, cut)).split('\n')[0].slice(0, 100);
}

/** Scratch cwd: the ranking pass reads no code, so it gets no checkout. */
function todoCwd(): string {
  const dir = join(STATE_DIR, 'todo');
  mkdirSync(dir, { recursive: true });
  return dir;
}
