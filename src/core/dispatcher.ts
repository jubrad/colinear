import { execFile } from 'node:child_process';
import { providerFor } from './provider.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, SessionInbox, type SessionCallbacks } from './agent.js';
import { runChecks } from './checks.js';
import { channels, projectChannel, type SessionChannels } from './channel.js';
import { coordinatorCwd, coordinatorPrompt, familyStatus, type CoordinatorTools } from './coordinator.js';
import { experimentOn } from './config.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { pollPrs } from './prs.js';
import { syncIssueState } from './statesync.js';
import { guidanceFor } from './guidance.js';
import { store } from './store.js';
import { questionSummary, type Config, type Issue, type PrInfo, type RepoConfig, type Subtask, type Task, type TaskEdits, type TriageVerdict, type Verification } from './types.js';

const exec = promisify(execFile);

const SUBTASKS_FILE = '.colinear-subtasks.md';

/** how many new sub-issues one tracking sweep will start (the rest wait a tick) */
const AUTO_DISPATCH_BATCH = 5;

/**
 * Sub-issues a tracking parent should start on its own: ones colinear has no
 * task for, that nobody has started in Linear either.
 *
 * The Linear state is the guard rather than "do we have a task": a sub-issue
 * that was worked months ago and then dropped from the store by retention has
 * a started/completed state, so it can never be resurrected here.
 */
export function autoDispatchable(parent: Task, subs: Issue[], configDefault: boolean): Issue[] {
  if (parent.status !== 'tracking') return [];
  if (!(parent.autoDispatchSubs ?? configDefault)) return [];
  return subs.filter(
    (sub) => !store.get(sub.id) && ['backlog', 'unstarted', 'triage'].includes(sub.stateType ?? ''),
  );
}

/** repo fields are enum-constrained to the config allowlist so routing can't
    silently miss on a name the model made up ("materialize-cloud", a path…) */
function triageSchema(repoNames: string[]) {
  const repo = { type: 'string', enum: repoNames };
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['do', 'too_big', 'needs_info'] },
      reason: { type: 'string' },
      plan: { type: 'string' },
      verification: { type: 'string', enum: ['local-light', 'ci', 'needs-env'] },
      repo,
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'number' },
            repo,
            blockedBy: { type: 'array', items: { type: 'number' } },
          },
          required: ['title', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdict', 'reason', 'repo'],
    additionalProperties: false,
  };
}

export class Dispatcher {
  private queue: string[] = [];
  private running = 0;
  private aborts = new Map<string, AbortController>();
  private suspended = new Set<string>();
  private modes = new Map<string, 'fixci' | 'rebase' | 'coordinate'>();
  /** mailboxes of the sessions running right now, keyed by task id */
  private inboxes = new Map<string, SessionInbox>();
  private viewer?: { id: string; displayName: string };

  constructor(private cfg: Config) {
    // unref: a pending timer must never keep the process alive after quit
    setInterval(() => void this.recheckBlocked(), 60_000).unref();
  }

  /** Abort every live session so quitting doesn't wait on (or orphan) agents. */
  shutdown() {
    for (const [id, controller] of this.aborts) {
      store.addActivity(id, 'colinear quit — agent stopped (resumes with r next run)');
      controller.abort();
    }
  }

  /** Where operator-facing messages go (the daemon forwards them to clients). */
  onToast?: (text: string, kind: 'info' | 'ok' | 'err') => void;

  private toast(text: string, kind: 'info' | 'ok' | 'err') {
    this.onToast?.(text, kind);
  }

  /**
   * Say something to a task's agent without attaching. A live session takes it
   * at its next turn boundary; otherwise it waits for the next session, since
   * dropping it silently is the one behaviour nobody can work with.
   */
  message(id: string, text: string, opts?: { wake?: boolean }) {
    const task = store.get(id);
    if (!task) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.inboxes.get(id)?.push(trimmed)) {
      store.addActivity(id, `you → agent: ${trimmed.slice(0, 120)}`);
      this.toast(`${task.issue.identifier}: delivered at the agent's next turn`, 'ok');
      return;
    }
    store.update(id, { inbox: [...(task.inbox ?? []), trimmed] });
    store.addActivity(id, `you → agent (queued): ${trimmed.slice(0, 120)}`);
    if (opts?.wake !== false && this.wake(id)) return;
    this.toast(`${task.issue.identifier}: no live agent — queued for its next session`, 'info');
  }

  /**
   * Start a session so a task reads what's waiting for it. Anything already
   * on its way (live, queued) needs no help, and `blocked` is left alone: a
   * message is not a reason to jump a dependency — `f` is.
   */
  private wake(id: string): boolean {
    const task = store.get(id);
    if (!task) return false;
    if (this.aborts.has(id) || this.queue.includes(id)) return false; // already coming
    if (['queued', 'blocked'].includes(task.status)) return false;
    if (task.question) return false; // it's mid-question; the answer resumes it
    // a tracking parent has no work of its own: waking it means coordinating
    // the family, which is the coordination experiment's job
    if (task.status === 'tracking') {
      if (!experimentOn(this.cfg, 'coordination')) return false;
      this.modes.set(id, 'coordinate');
    }
    store.update(id, {
      ...(task.status === 'tracking' ? {} : { status: 'queued' }),
      error: undefined,
      endedAt: undefined,
    });
    store.addActivity(id, task.status === 'tracking' ? 'woken to coordinate the family' : 'woken to read a message');
    this.toast(`${task.issue.identifier}: waking the agent to read it`, 'ok');
    this.queue.push(id);
    this.pump();
    return true;
  }

  /**
   * A tracking parent's coordinator session. It manages the family rather than
   * the code: no worktree of its own, no checks, no PR — and it stays
   * `tracking` throughout, because coordinating is not the parent going back
   * into development.
   */
  private async runCoordinator(id: string, controller: AbortController) {
    const task = store.get(id);
    if (!task) return;
    const messages = task.inbox ?? [];
    if (messages.length) store.update(id, { inbox: undefined });
    const coordChannels = experimentOn(this.cfg, 'coordination')
      ? channelsFor(task.issue, task.issue.identifier)
      : undefined;
    const inbox = new SessionInbox();
    this.inboxes.set(id, inbox);
    store.addActivity(id, 'coordinator session');
    try {
      const result = await runSession({
        prompt: coordinatorPrompt(task, coordChannels?.scopes.map((c) => c.id) ?? [], messages),
        cwd: coordinatorCwd(task),
        callbacks: this.callbacks(id),
        model: store.get(id)?.model ?? this.cfg.model,
        maxTurns: 30,
        abortController: controller,
        permissions: this.permissions(),
        channels: coordChannels,
        inbox,
        coordinator: this.coordinatorTools(id),
      });
      store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + result.costUsd });
      if (result.isError) {
        store.addActivity(id, `coordinator failed: ${result.errors.join('; ').slice(0, 120)}`);
      } else if (result.text.trim()) {
        store.addActivity(id, `coordinator: ${result.text.trim().split('\n')[0].slice(0, 140)}`);
      }
    } catch (err) {
      store.addActivity(id, `coordinator failed: ${String(err).slice(0, 120)}`);
    } finally {
      this.inboxes.delete(id);
      inbox.close();
      this.requeueUndelivered(id, inbox);
      // refreshTracking owns this status; a coordinator never changes it
      store.update(id, { status: 'tracking', endedAt: Date.now() });
    }
  }

  /**
   * What a coordinator may do to its family. Everything here is something the
   * operator can already do by hand — message, cancel, propose a split — so
   * the agent gains reach, not authority. Creating Linear issues is absent on
   * purpose: proposals wait for `A`.
   */
  private coordinatorTools(parentId: string): CoordinatorTools {
    const sub = (identifier: string): Task | undefined => {
      const parent = store.get(parentId);
      const match = parent?.subIssues?.find((s) => s.identifier.toLowerCase() === identifier.toLowerCase());
      return match ? store.get(match.id) : undefined;
    };
    return {
      status: () => {
        const parent = store.get(parentId);
        return parent ? familyStatus(parent) : 'parent is gone';
      },
      message: (identifier, text) => {
        const target = sub(identifier);
        if (!target) return `${identifier} is not a sub-issue of this family (or was never dispatched)`;
        this.message(target.issue.id, `${text}\n\n(relayed by the ${store.get(parentId)?.issue.identifier} coordinator)`);
        store.addActivity(parentId, `→ ${identifier}: ${text.slice(0, 80)}`);
        return `sent to ${identifier}`;
      },
      cancel: (identifier, reason) => {
        const target = sub(identifier);
        if (!target) return `${identifier} is not a sub-issue of this family`;
        const stopped = this.cancel(target.issue.id);
        store.addActivity(target.issue.id, `cancelled by the coordinator: ${reason.slice(0, 100)}`);
        store.addActivity(parentId, `cancelled ${identifier}: ${reason.slice(0, 80)}`);
        return stopped ? `cancelled ${identifier}` : `${identifier} had nothing running; it is parked`;
      },
      propose: (subtasks) => {
        const parent = store.get(parentId);
        if (!parent) return 'parent is gone';
        store.update(parentId, { proposals: [...(parent.proposals ?? []), ...subtasks] });
        store.addActivity(parentId, `proposed ${subtasks.length} sub-issue(s) — waiting on the operator`);
        this.toast(`${parent.issue.identifier}: ${subtasks.length} proposed sub-issue(s) — enter, then A`, 'info');
        return `proposed ${subtasks.length}; they are NOT created — the operator reviews them on the parent card and approves with A`;
      },
    };
  }

  /** A session can die between a push and the next turn; don't eat the message. */
  private requeueUndelivered(id: string, inbox: SessionInbox) {
    const undelivered = inbox.drain();
    if (!undelivered.length) return;
    const task = store.get(id);
    if (!task) return;
    store.update(id, { inbox: [...(task.inbox ?? []), ...undelivered] });
    store.addActivity(id, `${undelivered.length} message(s) went unread — kept for the next session`);
  }

  /** operator message onto a coordination channel (experimental) */
  channelPost(channel: string, text: string) {
    channels.post(channel, 'operator', 'operator', text);
    log(`channel ${channel}: operator posted`);
  }

  setViewer(viewer: { id: string; displayName: string }) {
    this.viewer = viewer;
  }

  /** Dispatch a session to fix red CI on the task's draft PR(s). */
  fixCi(id: string) {
    const task = store.get(id);
    if (!task || !task.prs.length || this.aborts.has(id) || this.queue.includes(id)) return;
    this.modes.set(id, 'fixci');
    store.update(id, { maintenance: 'fixci' });
    store.addActivity(id, 'CI failing — dispatching fix session');
    notify(this.cfg, task.issue.identifier, 'CI failing — dispatching fix', task.prs[0]?.url);
    this.queue.push(id);
    this.pump();
  }

  /**
   * Rebase a conflicting PR onto its base. Runs as a session because resolving
   * a conflict is a judgement call, not a mechanical merge — but the prompt
   * confines it to that: no scope changes, no new work.
   */
  rebase(id: string) {
    const task = store.get(id);
    if (!task || !task.prs.length || this.aborts.has(id) || this.queue.includes(id)) return;
    if (!task.worktree) {
      this.toast(`${task.issue.identifier}: no worktree to rebase in`, 'err');
      return;
    }
    this.modes.set(id, 'rebase');
    store.update(id, { maintenance: 'rebase' });
    store.addActivity(id, 'conflicts with base — dispatching a rebase');
    notify(this.cfg, task.issue.identifier, 'PR conflicts — rebasing', task.prs[0]?.url);
    this.queue.push(id);
    this.pump();
  }

  /** Abort a live session but park it as `interrupted` (for interactive attach). */
  suspend(id: string): boolean {
    const controller = this.aborts.get(id);
    if (!controller) return false;
    this.suspended.add(id);
    controller.abort();
    return true;
  }

  /** Abort a live session; task lands in error state with a cancel note. */
  cancel(id: string): boolean {
    // queued/blocked tasks have no live session — pull them out directly
    const qi = this.queue.indexOf(id);
    if (qi !== -1) this.queue.splice(qi, 1);
    const controller = this.aborts.get(id);
    if (controller) {
      controller.abort();
      store.addActivity(id, 'cancelled by user');
      return true;
    }
    const task = store.get(id);
    if (task && ['queued', 'blocked'].includes(task.status)) {
      // operator stop is not a failure — park it resumable, not in Failed
      store.update(id, { status: 'interrupted', error: undefined, blockedBy: undefined, endedAt: Date.now() });
      store.addActivity(id, 'cancelled before start — r to requeue');
      return true;
    }
    return false;
  }

  /**
   * Resume an interrupted/errored task. With a saved session id the SDK
   * continues the original transcript; otherwise the work pass restarts.
   */
  resume(id: string) {
    const task = store.get(id);
    // a tracking parent has no work of its own to resume; running it means
    // coordinating the family (experimental — otherwise r stays a no-op)
    if (task?.status === 'tracking') {
      if (!this.wake(id)) this.toast(`${task.issue.identifier}: coordination is off`, 'info');
      return;
    }
    if (!task || !['interrupted', 'error', 'escalated', 'needs_input', 'blocked'].includes(task.status)) return;
    if (task.question) return; // a live agent is waiting on an answer, not a restart
    store.update(id, { status: 'queued', error: undefined, endedAt: undefined, blockedBy: undefined });
    store.addActivity(id, task.sessionId ? 'resuming session' : 'restarting');
    this.queue.push(id);
    this.pump();
  }

  /**
   * Start a blocked task anyway. The blockers stay on the task as merge-order
   * dependencies: the work happens in parallel, the PR stays draft until they
   * land, and the agent is told what it is building ahead of.
   */
  force(id: string): boolean {
    const task = store.get(id);
    if (!task || task.status !== 'blocked') return false;
    const deps = (task.blockedBy ?? []).map((b) => ({ ...b, kind: 'merge' as const }));
    store.update(id, { status: 'queued', blockedBy: deps, error: undefined, endedAt: undefined });
    store.addActivity(
      id,
      deps.length
        ? `forced past ${deps.map((d) => d.identifier).join(', ')} — they must still merge first`
        : 'forced past blockers',
    );
    this.queue.push(id);
    this.pump();
    return true;
  }

  enqueue(
    issues: Issue[],
    opts?: { instructions?: string; model?: string; repo?: RepoConfig; skipTriage?: boolean },
  ) {
    for (const issue of issues) {
      if (store.get(issue.id)) continue;
      const task: Task = {
        issue,
        status: 'queued',
        activity: [],
        subtasks: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        checks: [],
        prs: [],
        costUsd: 0,
        instructions: opts?.instructions,
        model: opts?.model,
        skipTriage: opts?.skipTriage,
        repo: (({ name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot }) => ({ name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot }))(
          opts?.repo ?? this.cfg.repos[0],
        ),
      };
      store.upsert(task);
      if (opts?.instructions) store.addActivity(issue.id, `instructions: ${opts.instructions.slice(0, 100)}`);
      if (opts?.skipTriage) store.addActivity(issue.id, 'triage skipped by operator');
      if (opts?.model) store.addActivity(issue.id, `model: ${opts.model}`);
      if (opts?.repo) store.addActivity(issue.id, `repo: ${opts.repo.name}`);
      // dispatch = mine + in progress, immediately (not when an agent slot frees up)
      const viewer = this.viewer;
      if (viewer && issue.assigneeId !== viewer.id) {
        void providerFor(this.cfg).assign(issue.id, viewer.id)
          .then(() => store.addActivity(issue.id, `assigned to ${viewer.displayName}`))
          .catch((err) => store.addActivity(issue.id, `assign failed: ${String(err).slice(0, 80)}`));
      }
      void syncIssueState(this.cfg, issue, 'started');
      // respect Linear "blocks" relations: park behind unresolved blockers
      void (providerFor(this.cfg).capabilities.blockers
        ? providerFor(this.cfg).blockers(issue.id)
        : Promise.resolve([]))
        .catch(() => [])
        .then((blockers) => {
          const open = (blockers || []).filter((b) => !b.done && store.get(b.id)?.status !== 'done');
          if (store.get(issue.id)?.status !== 'queued') return; // already picked up/cancelled
          if (open.length) {
            store.update(issue.id, {
              status: 'blocked',
              blockedBy: open.map(({ id: bid, identifier }) => ({ id: bid, identifier, kind: 'start' as const })),
            });
            store.addActivity(issue.id, `blocked by ${open.map((b) => b.identifier).join(', ')}`);
          } else {
            this.queue.push(issue.id);
            this.pump();
          }
        });
    }
  }

  /**
   * Re-dispatch a task from scratch in a (possibly different) repo: fresh
   * worktree, fresh session, fresh triage. Keeps instructions/model/activity.
   * The old worktree (in the old repo) is left behind for inspection.
   */
  redispatch(id: string, repo: RepoConfig, opts?: { retriage?: boolean; skipTriage?: boolean }): boolean {
    const task = store.get(id);
    if (!task || this.aborts.has(id) || this.queue.includes(id)) return false;
    // a successful triage travels with the task unless the operator asks for a redo
    const keepTriage = !opts?.retriage && task.verdict?.verdict === 'do';
    // same repo: known/pinned PRs stay so the requeued agent adopts them;
    // different repo: they belong to the old repo and would mislead
    const repoChanged = repo.path !== (task.repo?.path ?? this.cfg.repos[0].path);
    store.update(id, {
      repo: { name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch, remote: repo.remote, pushRemote: repo.pushRemote, prBase: repo.prBase, worktreeRoot: repo.worktreeRoot },
      status: 'queued',
      sessionId: undefined,
      // the wiped pointer stays recoverable (TaskView shows previous sessions)
      sessionHistory: task.sessionId
        ? [...(task.sessionHistory ?? []), { sessionId: task.sessionId, worktree: task.worktree, at: Date.now() }].slice(-5)
        : task.sessionHistory,
      worktree: undefined,
      branch: undefined,
      verdict: keepTriage ? task.verdict : undefined,
      // explicit operator choice wins; keep-plan implies skipping the triage pass
      skipTriage: opts?.skipTriage ?? (keepTriage ? true : task.skipTriage),
      subtasks: [],
      checks: [],
      prs: repoChanged ? [] : task.prs,
      pinnedPr: repoChanged ? undefined : task.pinnedPr,
      error: undefined,
      blockedBy: undefined,
      endedAt: undefined,
      retried: false,
      ciFixAttempted: false,
    });
    store.addActivity(
      id,
      `re-dispatched in repo ${repo.name}${keepTriage ? ' (keeping triage plan)' : opts?.skipTriage ? ' (triage skipped)' : ' (fresh triage)'}`,
    );
    this.queue.push(id);
    this.pump();
    return true;
  }

  /**
   * Refresh `tracking` parents (issues handled entirely by their sub-issues):
   * update sub-issue progress, complete the parent when every sub lands, and
   * auto-convert failed/escalated parents that have Linear sub-issues and no
   * PRs of their own — no agent tokens needed to close those out.
   */
  async refreshTracking() {
    for (const task of store.list()) {
      const candidate =
        task.status === 'tracking' ||
        (['error', 'escalated'].includes(task.status) && !task.prs.length);
      if (!candidate) continue;
      if (!providerFor(this.cfg).capabilities.subIssues) continue;
      const subs = await providerFor(this.cfg).subIssues(task.issue.id).catch(() => null);
      if (!subs || !subs.length) continue;
      const subIssues = subs.map((s) => ({
        id: s.id,
        identifier: s.identifier,
        title: s.title,
        done:
          s.stateType === 'completed' ||
          s.stateType === 'canceled' ||
          store.get(s.id)?.status === 'done',
      }));
      // a sub-issue nobody has started, on a parent set up to run them: the
      // Linear state is the guard, so a task dropped by retention long after
      // it finished can't be resurrected here
      {
        const fresh = autoDispatchable(task, subs, this.cfg.autoDispatchSubs);
        if (fresh.length) {
          // bounded per sweep: nobody is watching a 60s timer, and a bulk
          // import shouldn't assign twenty issues to you at once
          const batch = fresh.slice(0, AUTO_DISPATCH_BATCH);
          const repo = this.cfg.repos.find((r) => r.path === task.repo?.path);
          this.enqueue(batch, { repo });
          store.addActivity(
            task.issue.id,
            `auto-dispatched ${batch.map((i) => i.identifier).join(', ')}` +
              (fresh.length > batch.length ? ` (${fresh.length - batch.length} more next sweep)` : ''),
          );
          this.toast(`${task.issue.identifier}: dispatched ${batch.length} new sub-issue(s)`, 'ok');
        }
      }

      const allDone = subIssues.every((s) => s.done);
      const nextStatus = allDone ? 'done' : 'tracking';
      const changed =
        task.status !== nextStatus || JSON.stringify(subIssues) !== JSON.stringify(task.subIssues);
      if (!changed) continue;
      if (task.status !== 'tracking' && !allDone) {
        store.addActivity(task.issue.id, `tracking ${subIssues.length} sub-issues`);
      }
      store.update(task.issue.id, { status: nextStatus, subIssues, error: undefined });
      if (allDone && task.status !== 'done') {
        store.addActivity(task.issue.id, 'all sub-issues done');
        notify(this.cfg, task.issue.identifier, 'all sub-issues done', task.issue.url);
      }
    }
  }

  /**
   * Park tasks whose Linear issue was closed by a human: abort any live agent
   * and move them to the Done column. Cancelled keeps its own distinct look;
   * completed lands as plain done. colinear never sets either state itself
   * (state sync only moves issues to started/review), so both always mean the
   * operator closed it out and whatever the board thinks is stale.
   */
  async sweepClosed() {
    const open = store.list().filter((t) => !['done', 'cancelled'].includes(t.status));
    if (!open.length) return;
    const fresh = await providerFor(this.cfg).issuesByIds(open.map((t) => t.issue.id)).catch(() => null);
    if (!fresh) return;
    for (const issue of fresh) {
      const closed =
        issue.stateType === 'canceled' ? 'cancelled' : issue.stateType === 'completed' ? 'done' : undefined;
      if (!closed) continue;
      if (!store.get(issue.id)) continue;
      this.cancel(issue.id); // dequeue / abort; the status below wins the race
      store.update(issue.id, {
        status: closed,
        issue,
        error: undefined,
        question: undefined,
        blockedBy: undefined,
        endedAt: store.get(issue.id)?.endedAt ?? Date.now(),
      });
      store.addActivity(issue.id, `issue ${closed === 'done' ? 'completed' : 'cancelled'} in Linear`);
    }
  }

  /**
   * Drop finished work older than the retention window. Only terminal states
   * go — nothing with an agent, a question, or an open PR — and the window is
   * also what the header's totals cover, so the two can't disagree.
   */
  sweepRetention() {
    const days = this.cfg.retentionDays;
    if (!days) return; // 0 keeps everything
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    for (const task of store.list()) {
      if (!['done', 'cancelled'].includes(task.status)) continue;
      if ((task.endedAt ?? Date.now()) > cutoff) continue;
      store.delete(task.issue.id);
      log(`retention: forgot ${task.issue.identifier} (${task.status})`);
    }
    for (const review of store.listReviews()) {
      if (!['stale', 'commented', 'approved', 'changes_requested'].includes(review.status)) continue;
      // a review that never ran has no endedAt; fall back to the PR's own mtime
      const settledAt = review.endedAt ?? (Date.parse(review.updatedAt) || Date.now());
      if (settledAt > cutoff) continue;
      store.deleteReview(review.id);
      log(`retention: forgot review ${review.id} (${review.status})`);
    }
  }

  /** Re-check blocked tasks; queue the ones whose Linear blockers finished. */
  /**
   * Apply the board's edit modal. The decision of whether an agent still
   * needs to run depends on what re-polling finds, so the whole sequence
   * belongs here rather than split across the wire.
   */
  async applyEdits(id: string, edits: TaskEdits) {
    const task = store.get(id);
    if (!task) return;
    const pinChanged = edits.pinnedPr !== task.pinnedPr;
    const repoChanged = edits.repo.path !== (task.repo?.path ?? this.cfg.repos[0].path);
    const { name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot } = edits.repo;
    store.update(id, {
      instructions: edits.instructions,
      model: edits.model,
      pinnedPr: edits.pinnedPr,
      // tri-state: undefined = keep plan chosen, leave the stored flag alone
      ...(edits.skipTriage !== undefined ? { skipTriage: edits.skipTriage } : {}),
      // also tri-state, but here undefined is a real choice: "follow config"
      autoRebase: edits.autoRebase,
      autoDispatchSubs: edits.autoDispatchSubs,
      // persist the repo even without a requeue: PR matching polls per repo,
      // so a pin can only resolve once the task points at the right one
      ...(repoChanged ? { repo: { name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot } } : {}),
    });
    const ident = task.issue.identifier;
    if (pinChanged || repoChanged) {
      // drop the stale match and re-poll; if the pin resolves the task on its
      // own (PR merged -> done, PR open -> pr_open), no agent needs to run
      store.update(id, { prs: [] });
      await this.pollPrs();
      const after = store.get(id);
      if (after?.status === 'done') return this.toast(`${ident}: PR already merged — moved to Done`, 'ok');
      if (after?.status === 'pr_open' && !edits.requeue) {
        return this.toast(`${ident}: linked to open PR — no agent needed`, 'ok');
      }
    }
    if (edits.requeue || repoChanged) {
      if (['triage', 'working', 'checks'].includes(store.get(id)?.status ?? '')) {
        return this.toast('agent is live — x to cancel before requeueing', 'err');
      }
      if (this.redispatch(id, edits.repo, { retriage: edits.retriage, skipTriage: edits.skipTriage })) {
        this.toast(`${ident} requeued in ${edits.repo.name}`, 'ok');
      }
    } else {
      this.toast(`${ident} updated`, 'ok');
    }
  }

  /** Re-match PRs now (the UI asks for this after editing a pin or repo). */
  async pollPrs() {
    await pollPrs(this.cfg, this).catch(() => {});
  }

  async recheckBlocked() {
    this.sweepRetention();
    await this.sweepClosed().catch(() => {});
    await this.refreshTracking().catch(() => {});
    // merge-order dependencies are tracked on every task, not just blocked ones:
    // the promote gate reads them long after the work is done
    for (const task of store.list()) {
      if (task.status !== 'blocked' && !task.blockedBy?.length) continue;
      if (!providerFor(this.cfg).capabilities.blockers) continue;
      const blockers = await providerFor(this.cfg).blockers(task.issue.id).catch(() => null);
      if (!blockers) continue;
      const kinds = new Map((task.blockedBy ?? []).map((b) => [b.id, b.kind]));
      const deps = blockers.map(({ id, identifier, done }) => ({
        id,
        identifier,
        kind: kinds.get(id) ?? ('start' as const),
        done: done || store.get(id)?.status === 'done',
      }));
      const holdingStart = deps.filter((d) => d.kind === 'start' && !d.done);

      if (task.status === 'blocked' && !holdingStart.length) {
        store.update(task.issue.id, { status: 'queued', blockedBy: deps.filter((d) => !d.done) });
        store.addActivity(task.issue.id, 'blockers resolved — queued');
        this.queue.push(task.issue.id);
        continue;
      }
      const next = deps.filter((d) => !d.done);
      if (JSON.stringify(next) !== JSON.stringify(task.blockedBy ?? [])) {
        store.update(task.issue.id, { blockedBy: next.length ? next : undefined });
      }
    }
    this.pump();
  }

  private pump() {
    while (this.running < this.cfg.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.running++;
      void this.runTask(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  /** what every session this dispatcher starts is allowed to do */
  private permissions() {
    return { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools };
  }

  private callbacks(id: string): SessionCallbacks {
    return {
      onActivity: (line) => store.addActivity(id, line),
      onSessionId: (sessionId) => {
        const prev = store.get(id);
        // a resume that crashes after init still mints a new id — keep the
        // old pointer so the real transcript is always recoverable
        const history =
          prev?.sessionId && prev.sessionId !== sessionId
            ? [...(prev.sessionHistory ?? []), { sessionId: prev.sessionId, worktree: prev.worktree, at: Date.now() }].slice(-5)
            : prev?.sessionHistory;
        store.update(id, { sessionId, sessionHistory: history });
      },
      onUsage: (u) => {
        const task = store.get(id);
        if (!task) return;
        store.update(id, {
          tokens: {
            input: task.tokens.input + u.input,
            output: task.tokens.output + u.output,
            cacheRead: (task.tokens.cacheRead ?? 0) + u.cacheRead,
            cacheWrite: (task.tokens.cacheWrite ?? 0) + u.cacheWrite,
          },
        });
      },
      onQuestion: (question) => {
        const task = store.get(id);
        if (!task) return;
        notify(this.cfg, task.issue.identifier, `needs input: ${questionSummary(question).slice(0, 80)}`, task.issue.url);
        store.update(id, {
          question: {
            ...question,
            answer: (answers: string[]) => {
              store.update(id, {
                question: undefined,
                status: store.get(id)?.statusBeforeQuestion ?? 'working',
              });
              for (const [i, a] of answers.entries()) {
                store.addActivity(id, `↩ ${question.questions[i]?.header ?? 'answered'}: ${a.slice(0, 80)}`);
              }
              question.answer(answers);
            },
          },
          statusBeforeQuestion: task.status,
          status: 'needs_input',
        });
      },
    };
  }

  private async runTask(id: string) {
    const task = store.get(id);
    if (!task) return;
    let issue = task.issue;
    let stopSubtaskPoll: (() => void) | undefined;
    const controller = new AbortController();
    this.aborts.set(id, controller);
    const mode = this.modes.get(id);
    this.modes.delete(id);
    if (mode === 'coordinate') {
      try {
        await this.runCoordinator(id, controller);
      } finally {
        this.aborts.delete(id);
      }
      return;
    }
    // all PRs merged = the work already landed; never burn an agent on it
    if (mode === undefined && task.prs.length && task.prs.every((pr) => pr.state === 'MERGED')) {
      store.update(id, { status: 'done', error: undefined });
      store.addActivity(id, 'PR(s) already merged — nothing to run');
      void this.recheckBlocked();
      return;
    }
    const resumeSession = task.sessionId && task.worktree && existsSync(task.worktree) ? task.sessionId : undefined;
    try {
      store.update(id, {
        // maintenance runs against a PR that already exists: moving the card
        // back to Working would read as the feature being rewritten
        ...(mode ? {} : { status: resumeSession || task.skipTriage ? 'working' : 'triage' }),
        startedAt: task.startedAt ?? Date.now(),
        endedAt: undefined,
      });
      // refresh the issue snapshot: persisted tasks carry dispatch-time data,
      // which goes stale (edited descriptions, parent links added later)
      const freshIssue = (await providerFor(this.cfg).issuesByIds([issue.id]).catch(() => []))[0];
      if (freshIssue) {
        issue = freshIssue;
        store.update(id, { issue: freshIssue });
      }
      // sub-issue agents get the family picture: parent goal + sibling scopes,
      // so parallel agents don't overlap or wander across boundaries
      let family: IssueFamily | undefined;
      if (issue.parent) {
        const [parentIssue, siblings] = await Promise.all([
          providerFor(this.cfg).issuesByIds([issue.parent.id]).then((r) => r[0]).catch(() => undefined),
          providerFor(this.cfg).subIssues(issue.parent.id).catch(() => undefined),
        ]);
        family = { parent: parentIssue, siblings: siblings?.filter((s) => s.id !== issue.id) };
      }
      store.addActivity(id, 'creating worktree');
      let taskRepo = task.repo ?? this.cfg.repos[0];
      // adopt an existing PR (operator-pinned first, else any open one):
      // work happens on its branch and the agent is told not to open another
      const knownPr =
        task.prs.find((pr) => pr.number === task.pinnedPr) ??
        task.prs.find((pr) => pr.state === 'OPEN');
      if (knownPr) store.addActivity(id, `adopting PR #${knownPr.number} (${knownPr.headRefName})`);
      let { worktree, branch } = await this.ensureWorktree(issue, taskRepo, knownPr?.headRefName);
      store.update(id, { worktree, branch });

      let plan: string | undefined;
      if (!resumeSession && task.skipTriage) {
        // a kept triage plan (e.g. repo re-dispatch) still feeds the work pass
        plan = store.get(id)?.verdict?.plan;
        store.addActivity(id, plan ? 'work pass (existing triage plan)' : 'work pass (triage skipped)');
      }
      // EXPERIMENTAL coordination channel, one per issue family: a sub-issue
      // joins its parent's, a tracking parent hosts its own. Sub-issue triage
      // joins too — scope questions surface earliest there.
      const sessionChannels = experimentOn(this.cfg, 'coordination')
        ? channelsFor(issue, store.get(id)?.subIssues?.length ? issue.identifier : undefined)
        : undefined;
      if (!resumeSession && !task.skipTriage) {
        store.addActivity(id, 'triage pass');
        const triageChannels = issue.parent ? sessionChannels : undefined;
        const triage = await runSession({
          prompt: `${triagePrompt(issue, this.cfg.repos, store.get(id)?.instructions, guidanceFor(this.cfg.guidance, 'triage'))}\n${familyBlock(issue, family)}${triageChannels ? channelBlock(triageChannels) : ''}`,
          cwd: worktree,
          callbacks: this.callbacks(id),
          outputSchema: triageSchema(this.cfg.repos.map((r) => r.name)),
          model: store.get(id)?.model ?? this.cfg.model,
          maxTurns: 40,
          abortController: controller,
          permissions: this.permissions(),
          channels: triageChannels,
        });
        store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + triage.costUsd });
        if (triage.isError) throw new Error(`triage failed: ${triage.errors.join('; ')}`);

        const verdict = triage.structured as TriageVerdict;
        store.update(id, { verdict });
        if (verdict.verification) store.addActivity(id, `verification: ${verdict.verification}`);

        // triage routes the work: switch repo (fresh worktree) if it picked another
        const chosen = verdict.repo && this.cfg.repos.find((r) => r.name === verdict.repo);
        if (verdict.repo && !chosen) {
          store.addActivity(id, `triage picked unknown repo "${verdict.repo}" — staying in ${taskRepo.name}`);
        } else if (chosen && chosen.path === taskRepo.path) {
          store.addActivity(id, `triage confirmed repo ${taskRepo.name}`);
        }
        if (chosen && chosen.path !== taskRepo.path) {
          store.addActivity(id, `triage routed to repo ${chosen.name}`);
          taskRepo = chosen;
          ({ worktree, branch } = await this.ensureWorktree(issue, chosen));
          store.update(id, {
            worktree,
            branch,
            repo: { name: chosen.name, path: chosen.path, defaultBranch: chosen.defaultBranch, remote: chosen.remote, pushRemote: chosen.pushRemote, prBase: chosen.prBase, worktreeRoot: chosen.worktreeRoot },
          });
        }
        if (verdict.verdict !== 'do') {
          // a too_big / needs_info verdict is a human decision — park it with
          // the questions, not the failures
          store.setStatus(id, 'needs_input');
          store.addActivity(id, `needs your input (${verdict.verdict}): ${verdict.reason.slice(0, 100)}`);
          notify(this.cfg, issue.identifier, `needs input: ${verdict.verdict}`, issue.url);
          return;
        }
        plan = verdict.plan;
        store.setStatus(id, 'working');
        store.addActivity(id, 'work pass');
      }

      stopSubtaskPoll = this.pollSubtasks(id, worktree);
      const current = store.get(id) ?? task;
      // messages typed while nothing was running ride into the opening prompt;
      // clear them here so a later session doesn't replay old instructions
      const queued = store.get(id)?.inbox ?? [];
      if (queued.length) store.update(id, { inbox: undefined });
      const ctx =
        taskContext(current, taskRepo, branch, family, guidanceFor(this.cfg.guidance, 'work')) +
        (sessionChannels ? channelBlock(sessionChannels) : '') +
        operatorBlock(queued);
      // the mailbox keeps this session open between turns, so `M` can reach it
      const inbox = new SessionInbox();
      this.inboxes.set(id, inbox);
      const work = await runSession({
        prompt:
          mode === 'rebase'
            ? rebasePrompt(ctx, issue, current.prs, taskRepo.prBase ?? taskRepo.defaultBranch, taskRepo.remote ?? 'origin', taskRepo.pushRemote ?? taskRepo.remote ?? 'origin')
            : mode === 'fixci'
              ? ciFixPrompt(ctx, issue, current.prs)
              : resumeSession && queued.length
                ? `${ctx}\n\nYou were idle and the operator sent you the message(s) above. Deal with them — check ${SUBTASKS_FILE} and git status to reorient first if you need to. If a message asks for a change, make it and push; if it only asks a question, answer it and stop.${knownPr ? ` The PR for this issue is #${knownPr.number} (branch "${knownPr.headRefName}") — push further commits there; do NOT open a new PR.` : ''}`
                : resumeSession
                ? `${ctx}\n\ncolinear was restarted and your session was interrupted. Review where you left off (check ${SUBTASKS_FILE}, git status, and your last steps) and finish the task, following all the original requirements.${knownPr ? ` The PR for this issue is #${knownPr.number} (branch "${knownPr.headRefName}") — push further commits there; do NOT open a new PR.` : ''}`
                : workPrompt(ctx, issue, taskRepo.pushRemote ?? taskRepo.remote ?? 'origin', taskRepo.remote ?? 'origin', taskRepo.prBase ?? taskRepo.defaultBranch, current.verdict?.verification, task.skipTriage, knownPr),
        cwd: worktree,
        callbacks: this.callbacks(id),
        model: store.get(id)?.model ?? this.cfg.model,
        resume: resumeSession,
        abortController: controller,
        permissions: this.permissions(),
        channels: sessionChannels,
        inbox,
      });
      this.inboxes.delete(id);
      inbox.close();
      this.requeueUndelivered(id, inbox);
      store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + work.costUsd });
      if (work.isError) {
        // auto-recovery: a spawn that died before its first assistant turn
        // clobbered the previous (good) session pointer at init — roll it
        // back, and retry once. Only when the superseded pointer belongs to
        // THIS worktree (a redispatch wipe is deliberate, don't undo it).
        const now = store.get(id);
        const prevPtr = now?.sessionHistory?.at(-1);
        if (work.assistantTurns === 0 && prevPtr && (!prevPtr.worktree || prevPtr.worktree === worktree)) {
          store.update(id, {
            sessionId: prevPtr.sessionId,
            sessionHistory: now!.sessionHistory!.slice(0, -1),
          });
          store.addActivity(id, `session crashed before starting — restored session ${prevPtr.sessionId.slice(0, 8)}…`);
          if (!now?.retried) {
            store.update(id, { status: 'queued', retried: true });
            store.addActivity(id, 'auto-retrying with the restored session in 5s');
            setTimeout(() => {
              this.queue.push(id);
              this.pump();
            }, 5_000);
            return;
          }
        }
        throw new Error(`work failed: ${work.errors.join('; ')}`);
      }

      // maintenance sessions run the repo's checks themselves, in the prompt —
      // re-running them here would flip the card to `checks` for no new signal
      const repoChecks = mode ? [] : (this.cfg.repos.find((r) => r.path === taskRepo.path)?.checks ?? this.cfg.checks);
      if (repoChecks.length) {
        store.setStatus(id, 'checks');
        store.addActivity(id, 'running checks');
        const results = await runChecks(repoChecks, worktree, controller.signal);
        store.update(id, { checks: results });
      }

      // decide the terminal status from actual PR state — setting done first
      // caused a visible done -> pr_open flicker (and stuck-done when the PR
      // wasn't matched)
      await pollPrs(this.cfg, this);
      const prs = store.get(id)?.prs ?? [];
      if (prs.some((pr) => pr.state === 'OPEN')) {
        store.setStatus(id, 'pr_open');
      } else if (prs.length && prs.every((pr) => pr.state === 'MERGED')) {
        store.setStatus(id, 'done');
      } else if (!prs.length) {
        store.update(id, { status: 'error', error: 'agent finished without an open PR (check activity)' });
      } else {
        store.setStatus(id, 'done');
      }
      notify(this.cfg, issue.identifier, 'agent finished', store.get(id)?.prs[0]?.url ?? issue.url);
      void this.recheckBlocked();
    } catch (err) {
      if (this.suspended.delete(id)) {
        store.update(id, { status: 'interrupted', error: undefined });
        store.addActivity(id, 'suspended — attached in terminal; press r to hand back to colinear');
        return;
      }
      // the cancelled-in-Linear sweep aborted us and already parked the task
      if (store.get(id)?.status === 'cancelled') return;
      const cancelled = controller.signal.aborted;
      // dead session pointer (transcript moved/deleted — e.g. the task was
      // re-routed to another repo and the old worktree's transcript can't be
      // found from the new cwd): retire it and restart fresh instead of
      // looping the same resume error on every r
      if (!cancelled && /No conversation found/i.test(String(err))) {
        const cur = store.get(id);
        store.update(id, {
          sessionId: undefined,
          sessionHistory: cur?.sessionId
            ? [...(cur.sessionHistory ?? []), { sessionId: cur.sessionId, worktree: cur.worktree, at: Date.now() }].slice(-5)
            : cur?.sessionHistory,
          status: 'queued',
          error: undefined,
        });
        store.addActivity(id, 'session transcript not found — pointer retired, restarting fresh');
        this.queue.push(id);
        this.pump();
        return;
      }
      const rateLimited = /529|overloaded|rate.?limit/i.test(String(err));
      if (!cancelled && rateLimited && !store.get(id)?.retried) {
        store.update(id, { status: 'queued', retried: true });
        store.addActivity(id, 'rate limited — retrying in 30s');
        setTimeout(() => {
          this.queue.push(id);
          this.pump();
        }, 30_000);
        return;
      }
      // a cancelled needs-input task must not keep its dead question around;
      // an operator stop parks as interrupted (resumable), never as a failure
      const now = store.get(id);
      // no verdict yet = stopped during triage: that transcript is a read-only
      // triage session, resuming it as the work pass would go sideways
      const midTriage = cancelled && !now?.verdict && !task.skipTriage;
      store.update(id, {
        status: cancelled ? 'interrupted' : 'error',
        error: cancelled ? undefined : String(err),
        question: undefined,
        ...(midTriage && now?.sessionId
          ? {
              sessionId: undefined,
              sessionHistory: [
                ...(now.sessionHistory ?? []),
                { sessionId: now.sessionId, worktree: now.worktree, at: Date.now() },
              ].slice(-5),
            }
          : {}),
      });
      store.addActivity(
        id,
        cancelled ? (midTriage ? 'stopped during triage — r restarts triage' : 'stopped — r to resume') : `error: ${String(err).slice(0, 200)}`,
      );
      if (!cancelled) {
        log(`task ${issue.identifier} failed: ${err}`);
        notify(this.cfg, issue.identifier, `error: ${String(err).slice(0, 80)}`);
      }
    } finally {
      this.aborts.delete(id);
      // a session that threw still has a registered mailbox; leaving it there
      // would swallow every later message into a stream nobody is reading
      const orphaned = this.inboxes.get(id);
      this.inboxes.delete(id);
      if (orphaned) {
        orphaned.close();
        this.requeueUndelivered(id, orphaned);
      }
      stopSubtaskPoll?.();
      // however a rebase ends — done, failed, aborted — it is no longer running
      // however it ended — done, failed, aborted — nothing is running now
      store.update(id, { endedAt: Date.now(), ...(store.get(id)?.maintenance ? { maintenance: undefined } : {}) });
    }
  }

  /** Agents maintain a checkbox list in .colinear-subtasks.md; poll and mirror it onto the card. */
  private pollSubtasks(id: string, worktree: string): () => void {
    const file = join(worktree, SUBTASKS_FILE);
    const read = () => {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        return;
      }
      const subtasks: Subtask[] = [];
      for (const line of content.split('\n')) {
        const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+)$/);
        if (m) subtasks.push({ done: m[1] !== ' ', text: m[2].trim() });
      }
      const task = store.get(id);
      if (task && JSON.stringify(subtasks) !== JSON.stringify(task.subtasks)) {
        store.update(id, { subtasks });
      }
    };
    read();
    const timer = setInterval(read, 2_000);
    return () => {
      clearInterval(timer);
      read();
    };
  }

  private async ensureWorktree(
    issue: Issue,
    repoCfg: { path: string; defaultBranch: string; remote?: string; pushRemote?: string; worktreeRoot: string },
    /** adopt an existing PR: check out its head branch instead of a fresh one */
    branchOverride?: string,
  ): Promise<{ worktree: string; branch: string }> {
    const { path: repo, defaultBranch, worktreeRoot } = repoCfg;
    const remote = repoCfg.remote ?? 'origin';
    const branch = branchOverride ?? providerFor(this.cfg).branchFor(issue);
    // git allows one checkout per branch: if some worktree (old path scheme,
    // manual checkout, attach shell) already has it, reuse that worktree
    const existing = await this.worktreeForBranch(repo, branch);
    if (existing && existing !== repo) {
      await this.excludeSubtasksFile(existing);
      return { worktree: existing, branch };
    }
    const worktree = join(worktreeRoot, issue.identifier);
    if (existsSync(worktree)) {
      if (branchOverride) {
        // adopting a PR into a pre-existing worktree: make sure it's on the PR's branch
        const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
        if (stdout.trim() !== branchOverride) {
          const prRemote = repoCfg.pushRemote ?? remote;
          await exec('git', ['-C', repo, 'fetch', prRemote, branchOverride]).catch(() => {});
          await exec('git', ['-C', worktree, 'checkout', branchOverride]).catch(async () => {
            await exec('git', ['-C', worktree, 'checkout', '-b', branchOverride, `${prRemote}/${branchOverride}`]).catch(() => {});
          });
        }
      }
      return { worktree, branch };
    }

    mkdirSync(worktreeRoot, { recursive: true });
    if (branchOverride) {
      // the PR's branch lives on the push remote in a fork workflow
      const prRemote = repoCfg.pushRemote ?? remote;
      await exec('git', ['-C', repo, 'fetch', prRemote, branchOverride]).catch(() => {});
      try {
        await exec('git', ['-C', repo, 'worktree', 'add', worktree, branchOverride]);
      } catch {
        await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branchOverride, `${prRemote}/${branchOverride}`]);
      }
      await this.excludeSubtasksFile(worktree);
      return { worktree, branch };
    }
    await exec('git', ['-C', repo, 'fetch', remote, defaultBranch]);
    try {
      await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch, `${remote}/${defaultBranch}`]);
    } catch {
      // branch already exists — attach the worktree to it instead
      await exec('git', ['-C', repo, 'worktree', 'add', worktree, branch]);
    }
    await this.excludeSubtasksFile(worktree);
    return { worktree, branch };
  }

  /** Path of the worktree that has `branch` checked out, if any. */
  private async worktreeForBranch(repo: string, branch: string): Promise<string | undefined> {
    const { stdout } = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain']).catch(() => ({ stdout: '' }));
    for (const block of stdout.split('\n\n')) {
      if (block.includes(`\nbranch refs/heads/${branch}`)) {
        return block.match(/^worktree (.+)$/m)?.[1];
      }
    }
    return undefined;
  }

  /** Keep the subtask scratch file out of git via the per-worktree exclude file. */
  private async excludeSubtasksFile(worktree: string) {
    try {
      const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir']);
      const excludePath = join(stdout.trim(), 'info', 'exclude');
      mkdirSync(dirname(excludePath), { recursive: true });
      const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      if (!existing.includes(SUBTASKS_FILE)) appendFileSync(excludePath, `${SUBTASKS_FILE}\n`);
    } catch {
      // non-fatal; the prompt also tells the agent not to commit it
    }
  }
}

function issueBlock(issue: Issue): string {
  return [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    '',
    'Description:',
    issue.description?.trim() || '(no description)',
  ].join('\n');
}

function instructionsBlock(instructions?: string): string {
  return instructions
    ? `\nSpecial instructions from the user (these take precedence over the defaults below when they conflict):\n${instructions}\n`
    : '';
}

interface RepoLike {
  name?: string;
  path: string;
  defaultBranch: string;
  remote?: string;
  pushRemote?: string;
  prBase?: string;
}

/** Everything the agent should know about this task, shared by all session prompts. */
interface IssueFamily {
  parent?: Issue;
  siblings?: Issue[];
}

/**
 * What this issue must land after. An agent that doesn't know it is building
 * ahead of something else reimplements it, or writes a PR nobody can order.
 */
function dependencyBlock(task: Task): string {
  const deps = (task.blockedBy ?? []).filter((d) => !d.done);
  if (!deps.length) return '';
  const merge = deps.filter((d) => d.kind === 'merge');
  const start = deps.filter((d) => d.kind === 'start');
  const lines = ['', '## Dependencies'];
  if (merge.length) {
    lines.push(
      `This issue must MERGE after: ${merge.map((d) => d.identifier).join(', ')}. That work is happening in parallel — possibly in another repository — and is not merged yet.`,
      '',
      'So: build against the current state of your base branch, and do not wait for it or reimplement what it provides. If you depend on something it introduces that does not exist yet, code against the interface it will expose and say so plainly in the PR body — state which issue must land (and deploy) first, and why. Never mark your PR ready; the operator promotes it once the dependency has shipped.',
    );
  }
  if (start.length) {
    lines.push(`Blocked by (not yet resolved): ${start.map((d) => d.identifier).join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * The channel an issue belongs to: its parent's family, or — for a parent
 * tracking sub-issues — its own. Nothing else gets one; a lone task has
 * nobody to coordinate with.
 */
function channelsFor(issue: Issue, ownFamily?: string): SessionChannels | undefined {
  const scopes: SessionChannels['scopes'] = [];
  const family = issue.parent?.identifier ?? ownFamily;
  if (family) scopes.push({ scope: 'family', id: `#${family}` });
  // a project channel reaches the agents you would otherwise never hear from:
  // different families, same release
  if (issue.projectName) scopes.push({ scope: 'project', id: projectChannel(issue.projectName) });
  return scopes.length ? { username: issue.identifier, scopes } : undefined;
}

/** Operator messages that arrived while nothing was running. */
function operatorBlock(messages: string[]): string {
  if (!messages.length) return '';
  return `

## Messages from the operator
These arrived while you weren't running. They come from the human running colinear and outrank the task description wherever they conflict.
${messages.map((m) => `- ${m}`).join('\n')}`;
}

function channelBlock(membership: SessionChannels): string {
  const family = membership.scopes.find((c) => c.scope === 'family');
  const project = membership.scopes.find((c) => c.scope === 'project');
  const lines = [
    '',
    '',
    `## Coordination channels (experimental) — you are ${membership.username} here`,
    'Tools: mcp__colinear__channel_read (new messages since your last read — you never see duplicates)',
    'and mcp__colinear__channel_post (short message, max ~2 lines; your name is stamped automatically).',
    membership.scopes.length > 1
      ? `Both take scope: ${membership.scopes.map((c) => `"${c.scope}" = ${c.id}`).join(', ')}. Default is ${membership.scopes[0].id}.`
      : `Your channel is ${membership.scopes[0].id}.`,
  ];
  if (family) {
    lines.push(
      `${family.id} is your issue family — the agents whose work touches yours:`,
      '- READ at session start, before structural/architectural decisions, and before opening your PR.',
      '- POST: a scope claim at session start (files/dirs you own), architectural decisions siblings must',
      '  know about, advisory claims on shared resources ("using the kind cluster ~20min"), your PR link',
      '  when opened, and a done notice.',
    );
  }
  if (project) {
    lines.push(
      `${project.id} is the whole project — other families working the same release. Keep it quieter:`,
      '- POST only what someone outside your family would need: a shared interface or schema you are',
      '  changing, a contended environment you are taking, a decision that constrains other issues.',
      '- READ it before a change that reaches outside your own issue.',
    );
  }
  lines.push('- OPERATOR messages outrank everything else in any channel.');
  return lines.join('\n');
}

function familyBlock(issue: Issue, family?: IssueFamily): string {
  if (!issue.parent || !family) return '';
  const lines: string[] = ['', `## Parent & sibling context`];
  if (family.parent) {
    lines.push(
      `Parent issue ${family.parent.identifier}: ${family.parent.title}`,
      family.parent.description?.trim()
        ? `Parent description (overall goal):\n${family.parent.description.trim().slice(0, 1500)}`
        : '',
    );
  } else {
    lines.push(`Parent issue: ${issue.parent.identifier}`);
  }
  if (family.siblings?.length) {
    lines.push(
      '',
      'Sibling sub-issues, handled by OTHER agents in parallel:',
      ...family.siblings.map(
        (s) => `- ${s.identifier} [${s.stateName}] ${s.title}`,
      ),
      '',
      'Boundaries: implement ONLY this issue\'s scope. Do not implement, refactor, or "helpfully fix" anything a sibling covers — overlapping solutions create merge conflicts and duplicated work. If your work genuinely requires something a sibling owns and it has not landed yet, note the dependency in your PR body instead of building it.',
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}


function taskContext(
  task: Task,
  repo: RepoLike,
  branch: string,
  family?: IssueFamily,
  guidance?: string,
): string {
  const issue = task.issue;
  const remote = repo.remote ?? 'origin';
  const pushRemote = repo.pushRemote ?? remote;
  const prBase = repo.prBase ?? repo.defaultBranch;
  const prLine = task.prs.length
    ? `Existing PR(s): ${task.prs
        .map(
          (pr) =>
            `#${pr.number} [${pr.isDraft ? 'draft' : pr.state.toLowerCase()}, ci:${pr.checksStatus}${
              task.pinnedPr === pr.number ? ', PINNED by operator — this is the canonical PR' : ''
            }] ${pr.url}`,
        )
        .join('; ')}`
    : '';
  return [
    '## Task context',
    `Linear issue ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    issue.parent ? `Parent issue: ${issue.parent.identifier} (this is a sub-issue of it)` : '',
    '',
    'Issue description:',
    issue.description?.trim() || '(no description)',
    '',
    `Repository: ${repo.name ?? repo.path} at ${repo.path}. You are in a dedicated git worktree on branch "${branch}". PRs target "${prBase}" on remote "${remote}"; pushes go to "${pushRemote}"${pushRemote !== remote ? ' (fork workflow)' : ''}.`,
    prLine,
    task.verdict
      ? `Triage verdict: ${task.verdict.verdict}${task.verdict.verification ? ` · verification tier: ${task.verdict.verification}` : ''} — ${task.verdict.reason}`
      : '',
    task.verdict?.plan ? `\nTriage plan:\n${task.verdict.plan}` : '',
    guidance ?? '',
    task.instructions
      ? `\nOperator instructions for THIS issue (these take precedence over the standing guidance and anything else):\n${task.instructions}`
      : '',
    dependencyBlock(task),
    familyBlock(task.issue, family),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function triagePrompt(
  issue: Issue,
  repos: RepoConfig[],
  instructions?: string,
  guidance?: string,
): string {
  const roster = repos
    .map((r) => `- ${r.name} (${r.path}): ${r.description ?? '(no description)'}`)
    .join('\n');
  return `You are triaging a Linear issue before implementation. Investigate the codebase (read-only — do not modify files) to judge scope.

${issueBlock(issue)}${guidance ?? ''}
${instructionsBlock(instructions)}
Work for this team can live in any of these repositories:
${roster}

FIRST decide which repository this issue's work belongs in — return it as "repo" (one of: ${repos.map((r) => r.name).join(', ')}). Your current working directory is a worktree of one of them, but you can and should read the other repos at their listed paths to check where the relevant code actually lives. If you pick a different repo than your cwd, the work session will start there.

Decide one of:
- "do": clearly scoped, a single agent can complete it with one PR (or a small stack). Include a short implementation plan.
- "too_big": needs to be broken up into multiple issues. Explain why — AND include "subtasks": an ordered array of proposed sub-issues, each completable by one agent with one PR in ONE repository. Per subtask: title (actionable, self-contained), description (context + acceptance criteria, markdown — assume the reader has not seen this issue), optional priority (1 urgent … 4 low), repo (one of: ${repos.map((r) => r.name).join(', ')}), and blockedBy (array of zero-based indices of subtasks that must land first). The user will review, edit selection, and approve these into Linear.
- "needs_info": the issue is ambiguous or missing decisions only a human can make. State exactly what's missing.

Also decide HOW the change should be verified ("verification") — this repo may have expensive, contended local environments (shared clusters, personal cloud stacks, fixed local ports), so prefer the cheapest sufficient tier:
- "local-light": linters + unit tests near the change are sufficient. The default.
- "ci": the repository's CI covers this change. Before choosing this, read the CI configuration (.github/workflows/, buildkite, etc.) and confirm the jobs that exercise your changed area actually run on pull requests. Prefer this over heavyweight local verification when true.
- "needs-env": verification truly requires a local cluster, deployed stack, or other exclusive environment. Choose only when unavoidable.

Only use AskUserQuestion if a single quick answer would flip you from needs_info to do.`;
}

function verificationBlock(verification?: Verification): string {
  switch (verification) {
    case 'ci':
      return `- Verification tier: CI. Run linters and fast unit tests locally, but do NOT run heavyweight local suites or spin up local environments — push the branch and open the draft PR EARLY so GitHub CI carries the expensive tests. After pushing, check "gh pr checks" and fix any failures.`;
    case 'needs-env':
      return `- Verification tier: needs-env. Local environments here are shared and contended — run linters, unit tests, and whatever verification you can without claiming a cluster/stack. List everything you could NOT verify in the PR body under a "Needs environment verification" section so the human knows what to exercise.`;
    default:
      return `- Verification tier: local-light. Run the repository's linters and the relevant unit tests for the code you touch before committing. Include "run lints" and "run tests" as subtasks.`;
  }
}

function workPrompt(
  ctx: string,
  issue: Issue,
  pushRemote: string,
  upstreamRemote: string,
  prBase: string,
  verification?: Verification,
  triageSkipped?: boolean,
  existingPr?: PrInfo,
): string {
  const forked = pushRemote !== upstreamRemote;
  const skipNote = triageSkipped
    ? `\nNo triage pass ran for this issue (the operator skipped it). Do a brief investigation before writing code. If the issue turns out to be far larger than a single PR, or hinges on decisions only a human can make, use AskUserQuestion instead of guessing.\n`
    : '';
  const adoptNote = existingPr
    ? `\nA PR ALREADY EXISTS for this issue: #${existingPr.number} (${existingPr.url}), branch "${existingPr.headRefName}" — your worktree is on that branch. Start by reviewing its current diff ("gh pr view ${existingPr.number}", "git log", "git diff ${prBase}...HEAD") and ADOPT it: continue the work with additional commits pushed to this branch. Do NOT create a new branch or open another PR.\n`
    : '';
  return `${ctx}

Implement this Linear issue.${skipNote}${adoptNote}
Before writing any code, create ${SUBTASKS_FILE} in the worktree root: a short markdown checklist (3-8 items) of the subtasks needed to complete this issue. As you finish each subtask, immediately update its checkbox to [x]. Keep this file current — it drives a progress display. Never commit it (it is git-excluded).

Requirements:
- Follow the repository's CLAUDE.md conventions.
${verificationBlock(verification)}
- Commit with clear messages referencing ${issue.identifier}.
- Before opening the PR, spawn a subagent (Task tool) to review your full branch diff for bugs, missed edge cases, and convention violations. Address any real findings. Include this review as a subtask.
${existingPr ? `- Push further commits to the "${pushRemote}" remote branch "${existingPr.headRefName}" — they land on the existing PR #${existingPr.number}. Never open a second PR.` : `- Push the branch to the "${pushRemote}" remote${forked ? ` (a fork — the upstream is "${upstreamRemote}")` : ''} and open a DRAFT PR against ${prBase} of the upstream repo with "gh pr create --draft --base ${prBase}"${forked ? ' (gh handles fork PRs; pass --head <fork-owner>:<branch> if it asks)' : ''}, title prefixed with "${issue.identifier}:", body linking ${issue.url}.`}
- PRs stay DRAFT: never run "gh pr ready" or mark a PR ready for review — promoting a PR out of draft is always a human decision.
${forked ? '- Do NOT create stacked PRs: this repo uses a fork workflow and stacked PRs require pushing to the upstream. Keep it to a single PR.' : '- If the change is genuinely better split into stacked PRs, create stacked branches off this one and open a draft PR per layer, each based on the previous branch.'}
- If you get blocked on a decision only a human can make, use AskUserQuestion.`;
}

function rebasePrompt(
  ctx: string,
  issue: Issue,
  prs: Task['prs'],
  prBase: string,
  remote: string,
  pushRemote: string,
): string {
  const pr = prs[0];
  return `${ctx}

Your PR for ${issue.identifier}${pr ? ` (#${pr.number}, branch "${pr.headRefName}")` : ''} now conflicts with ${prBase}. Rebase it — nothing else.

1. \`git -C . fetch ${remote} ${prBase}\`, then \`git rebase ${remote}/${prBase}\`.
2. Resolve each conflict on its merits. Read enough of both sides to understand what the other change was for: the base moved for a reason, and keeping your version wholesale is usually wrong. Where the two genuinely disagree about behaviour, prefer the base's intent and adapt your change to it.
3. Run the repository's linters and the tests around what you touched. A rebase that compiles but breaks a test the base added is a failed rebase.
4. \`git push --force-with-lease ${pushRemote} ${pr?.headRefName ?? 'HEAD'}\`.

Do NOT change scope, add features, or "improve" anything while you are in here — a rebase that also refactors is impossible to review. If a conflict cannot be resolved without a decision only a human can make (the base removed something you depend on, two features genuinely collide), stop and use AskUserQuestion rather than guessing.

Never mark the PR ready; promoting it stays the operator's call. Say plainly in your final message what conflicted and how you resolved it.`;
}

function ciFixPrompt(ctx: string, issue: Issue, prs: Task['prs']): string {
  const prList = prs.map((pr) => `#${pr.number} (${pr.headRefName})`).join(', ');
  return `${ctx}

CI is failing on your draft PR(s) for ${issue.identifier}: ${prList}.

Diagnose and fix:
1. "gh pr checks <number>" to see which checks failed.
2. "gh run view <run-id> --log-failed" for the failing logs.
3. Fix the root cause in this worktree, run the relevant linters/tests locally, commit, and push.
4. If a failure is clearly unrelated flaky infrastructure (not your change), do not chase it — say so in your final message and stop.

PRs stay DRAFT: never run "gh pr ready" — promoting is a human decision.`;
}
