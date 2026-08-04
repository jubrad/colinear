import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { runChecks } from './checks.js';
import { assignIssue, fetchBlockers, fetchIssuesByIds, fetchSubIssues } from './linear.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { pollPrs } from './prs.js';
import { syncIssueState } from './statesync.js';
import { store } from './store.js';
import type { Config, LinearIssue, PrInfo, RepoConfig, Subtask, Task, TriageVerdict, Verification } from './types.js';

const exec = promisify(execFile);

const SUBTASKS_FILE = '.colinear-subtasks.md';

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['do', 'too_big', 'needs_info'] },
    reason: { type: 'string' },
    plan: { type: 'string' },
    verification: { type: 'string', enum: ['local-light', 'ci', 'needs-env'] },
    repo: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'number' },
          repo: { type: 'string' },
          blockedBy: { type: 'array', items: { type: 'number' } },
        },
        required: ['title', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

export class Dispatcher {
  private queue: string[] = [];
  private running = 0;
  private aborts = new Map<string, AbortController>();
  private suspended = new Set<string>();
  private modes = new Map<string, 'fixci'>();
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

  setViewer(viewer: { id: string; displayName: string }) {
    this.viewer = viewer;
  }

  /** Dispatch a session to fix red CI on the task's draft PR(s). */
  fixCi(id: string) {
    const task = store.get(id);
    if (!task || !task.prs.length || this.aborts.has(id) || this.queue.includes(id)) return;
    this.modes.set(id, 'fixci');
    store.update(id, { status: 'queued' });
    store.addActivity(id, 'CI failing — dispatching fix session');
    notify(this.cfg, task.issue.identifier, 'CI failing — dispatching fix', task.prs[0]?.url);
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
      store.update(id, { status: 'error', error: 'cancelled', blockedBy: undefined, endedAt: Date.now() });
      store.addActivity(id, 'cancelled before start');
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
    if (!task || !['interrupted', 'error', 'escalated', 'needs_input', 'blocked'].includes(task.status)) return;
    if (task.question) return; // a live agent is waiting on an answer, not a restart
    store.update(id, { status: 'queued', error: undefined, endedAt: undefined, blockedBy: undefined });
    store.addActivity(id, task.sessionId ? 'resuming session' : 'restarting');
    this.queue.push(id);
    this.pump();
  }

  enqueue(
    issues: LinearIssue[],
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
        void assignIssue(this.cfg, issue.id, viewer.id)
          .then(() => store.addActivity(issue.id, `assigned to ${viewer.displayName}`))
          .catch((err) => store.addActivity(issue.id, `assign failed: ${String(err).slice(0, 80)}`));
      }
      void syncIssueState(this.cfg, issue, 'started');
      // respect Linear "blocks" relations: park behind unresolved blockers
      void fetchBlockers(this.cfg, issue.id)
        .catch(() => [])
        .then((blockers) => {
          const open = (blockers || []).filter((b) => !b.done && store.get(b.id)?.status !== 'done');
          if (store.get(issue.id)?.status !== 'queued') return; // already picked up/cancelled
          if (open.length) {
            store.update(issue.id, {
              status: 'blocked',
              blockedBy: open.map(({ id: bid, identifier }) => ({ id: bid, identifier })),
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
      const subs = await fetchSubIssues(this.cfg, task.issue.id).catch(() => null);
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

  /** Re-check blocked tasks; queue the ones whose Linear blockers finished. */
  async recheckBlocked() {
    await this.refreshTracking().catch(() => {});
    for (const task of store.list().filter((t) => t.status === 'blocked')) {
      const blockers = await fetchBlockers(this.cfg, task.issue.id).catch(() => null);
      if (!blockers) continue;
      const open = blockers.filter((b) => !b.done && store.get(b.id)?.status !== 'done');
      if (open.length) {
        store.update(task.issue.id, { blockedBy: open.map(({ id, identifier }) => ({ id, identifier })) });
        continue;
      }
      store.update(task.issue.id, { status: 'queued', blockedBy: undefined });
      store.addActivity(task.issue.id, 'blockers resolved — queued');
      this.queue.push(task.issue.id);
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
        notify(this.cfg, task.issue.identifier, `needs input: ${question.text.slice(0, 80)}`, task.issue.url);
        store.update(id, {
          question: {
            ...question,
            answer: (a: string) => {
              store.update(id, {
                question: undefined,
                status: store.get(id)?.statusBeforeQuestion ?? 'working',
              });
              store.addActivity(id, `↩ answered: ${a.slice(0, 80)}`);
              question.answer(a);
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
    // all PRs merged = the work already landed; never burn an agent on it
    if (mode !== 'fixci' && task.prs.length && task.prs.every((pr) => pr.state === 'MERGED')) {
      store.update(id, { status: 'done', error: undefined });
      store.addActivity(id, 'PR(s) already merged — nothing to run');
      void this.recheckBlocked();
      return;
    }
    const resumeSession = task.sessionId && task.worktree && existsSync(task.worktree) ? task.sessionId : undefined;
    try {
      store.update(id, {
        status: resumeSession || task.skipTriage ? 'working' : 'triage',
        startedAt: task.startedAt ?? Date.now(),
        endedAt: undefined,
      });
      // refresh the issue snapshot: persisted tasks carry dispatch-time data,
      // which goes stale (edited descriptions, parent links added later)
      const freshIssue = (await fetchIssuesByIds(this.cfg, [issue.id]).catch(() => []))[0];
      if (freshIssue) {
        issue = freshIssue;
        store.update(id, { issue: freshIssue });
      }
      // sub-issue agents get the family picture: parent goal + sibling scopes,
      // so parallel agents don't overlap or wander across boundaries
      let family: IssueFamily | undefined;
      if (issue.parent) {
        const [parentIssue, siblings] = await Promise.all([
          fetchIssuesByIds(this.cfg, [issue.parent.id]).then((r) => r[0]).catch(() => undefined),
          fetchSubIssues(this.cfg, issue.parent.id).catch(() => undefined),
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
      if (!resumeSession && !task.skipTriage) {
        store.addActivity(id, 'triage pass');
        const triage = await runSession({
          prompt: `${triagePrompt(issue, this.cfg.repos, store.get(id)?.instructions)}\n${familyBlock(issue, family)}`,
          cwd: worktree,
          callbacks: this.callbacks(id),
          outputSchema: TRIAGE_SCHEMA,
          model: store.get(id)?.model ?? this.cfg.model,
          maxTurns: 40,
          abortController: controller,
        });
        store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + triage.costUsd });
        if (triage.isError) throw new Error(`triage failed: ${triage.errors.join('; ')}`);

        const verdict = triage.structured as TriageVerdict;
        store.update(id, { verdict });
        if (verdict.verification) store.addActivity(id, `verification: ${verdict.verification}`);

        // triage routes the work: switch repo (fresh worktree) if it picked another
        const chosen = verdict.repo && this.cfg.repos.find((r) => r.name === verdict.repo);
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
      const ctx = taskContext(current, taskRepo, branch, family);
      const work = await runSession({
        prompt:
          mode === 'fixci'
            ? ciFixPrompt(ctx, issue, current.prs)
            : resumeSession
              ? `${ctx}\n\ncolinear was restarted and your session was interrupted. Review where you left off (check ${SUBTASKS_FILE}, git status, and your last steps) and finish the task, following all the original requirements.${knownPr ? ` The PR for this issue is #${knownPr.number} (branch "${knownPr.headRefName}") — push further commits there; do NOT open a new PR.` : ''}`
              : workPrompt(ctx, issue, taskRepo.pushRemote ?? taskRepo.remote ?? 'origin', taskRepo.remote ?? 'origin', taskRepo.prBase ?? taskRepo.defaultBranch, current.verdict?.verification, task.skipTriage, knownPr),
        cwd: worktree,
        callbacks: this.callbacks(id),
        model: store.get(id)?.model ?? this.cfg.model,
        resume: resumeSession,
        abortController: controller,
      });
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

      const repoChecks = this.cfg.repos.find((r) => r.path === taskRepo.path)?.checks ?? this.cfg.checks;
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
      const cancelled = controller.signal.aborted;
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
      // a cancelled needs-input task must not keep its dead question around
      store.update(id, { status: 'error', error: cancelled ? 'cancelled' : String(err), question: undefined });
      store.addActivity(id, cancelled ? 'stopped' : `error: ${String(err).slice(0, 200)}`);
      if (!cancelled) {
        log(`task ${issue.identifier} failed: ${err}`);
        notify(this.cfg, issue.identifier, `error: ${String(err).slice(0, 80)}`);
      }
    } finally {
      this.aborts.delete(id);
      stopSubtaskPoll?.();
      store.update(id, { endedAt: Date.now() });
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
    issue: LinearIssue,
    repoCfg: { path: string; defaultBranch: string; remote?: string; pushRemote?: string; worktreeRoot: string },
    /** adopt an existing PR: check out its head branch instead of a fresh one */
    branchOverride?: string,
  ): Promise<{ worktree: string; branch: string }> {
    const { path: repo, defaultBranch, worktreeRoot } = repoCfg;
    const remote = repoCfg.remote ?? 'origin';
    const branch = branchOverride ?? issue.branchName ?? issue.identifier.toLowerCase();
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

function issueBlock(issue: LinearIssue): string {
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
  parent?: LinearIssue;
  siblings?: LinearIssue[];
}

function familyBlock(issue: LinearIssue, family?: IssueFamily): string {
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

function taskContext(task: Task, repo: RepoLike, branch: string, family?: IssueFamily): string {
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
    task.instructions
      ? `\nOperator instructions (these take precedence when they conflict with anything else):\n${task.instructions}`
      : '',
    familyBlock(task.issue, family),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function triagePrompt(issue: LinearIssue, repos: RepoConfig[], instructions?: string): string {
  const roster = repos
    .map((r) => `- ${r.name} (${r.path}): ${r.description ?? '(no description)'}`)
    .join('\n');
  return `You are triaging a Linear issue before implementation. Investigate the codebase (read-only — do not modify files) to judge scope.

${issueBlock(issue)}
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
  issue: LinearIssue,
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

function ciFixPrompt(ctx: string, issue: LinearIssue, prs: Task['prs']): string {
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
