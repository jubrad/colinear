import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { runChecks } from './checks.js';
import { assignIssue, fetchBlockers } from './linear.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { pollPrs } from './prs.js';
import { syncIssueState } from './statesync.js';
import { store } from './store.js';
import type { Config, LinearIssue, RepoConfig, Subtask, Task, TriageVerdict, Verification } from './types.js';

const exec = promisify(execFile);

const SUBTASKS_FILE = '.colinear-subtasks.md';

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['do', 'too_big', 'needs_info'] },
    reason: { type: 'string' },
    plan: { type: 'string' },
    verification: { type: 'string', enum: ['local-light', 'ci', 'needs-env'] },
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
    setInterval(() => void this.recheckBlocked(), 60_000);
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
    const controller = this.aborts.get(id);
    if (!controller) return false;
    controller.abort();
    store.addActivity(id, 'cancelled by user');
    return true;
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

  enqueue(issues: LinearIssue[], opts?: { instructions?: string; model?: string; repo?: RepoConfig }) {
    for (const issue of issues) {
      if (store.get(issue.id)) continue;
      const task: Task = {
        issue,
        status: 'queued',
        activity: [],
        subtasks: [],
        tokens: { input: 0, output: 0 },
        checks: [],
        prs: [],
        costUsd: 0,
        instructions: opts?.instructions,
        model: opts?.model,
        repo: (({ name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot }) => ({ name, path, defaultBranch, remote, pushRemote, prBase, worktreeRoot }))(
          opts?.repo ?? this.cfg.repos[0],
        ),
      };
      store.upsert(task);
      if (opts?.instructions) store.addActivity(issue.id, `instructions: ${opts.instructions.slice(0, 100)}`);
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

  /** Re-check blocked tasks; queue the ones whose Linear blockers finished. */
  async recheckBlocked() {
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
      onSessionId: (sessionId) => store.update(id, { sessionId }),
      onUsage: (u) => {
        const task = store.get(id);
        if (!task) return;
        store.update(id, {
          tokens: { input: task.tokens.input + u.input, output: task.tokens.output + u.output },
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
    const { issue } = task;
    let stopSubtaskPoll: (() => void) | undefined;
    const controller = new AbortController();
    this.aborts.set(id, controller);
    const mode = this.modes.get(id);
    this.modes.delete(id);
    const resumeSession = task.sessionId && task.worktree && existsSync(task.worktree) ? task.sessionId : undefined;
    try {
      store.update(id, { status: resumeSession ? 'working' : 'triage', startedAt: task.startedAt ?? Date.now(), endedAt: undefined });
      store.addActivity(id, 'creating worktree');
      const taskRepo = task.repo ?? this.cfg.repos[0];
      const { worktree, branch } = await this.ensureWorktree(issue, taskRepo);
      store.update(id, { worktree, branch });

      let plan: string | undefined;
      if (!resumeSession) {
        store.addActivity(id, 'triage pass');
        const triage = await runSession({
          prompt: triagePrompt(issue, this.cfg.repos.map((r) => r.name), store.get(id)?.instructions),
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
      const current = store.get(id);
      const work = await runSession({
        prompt:
          mode === 'fixci'
            ? ciFixPrompt(issue, current?.prs ?? [])
            : resumeSession
              ? `colinear was restarted and your session was interrupted. Review where you left off (check ${SUBTASKS_FILE}, git status, and your last steps) and finish the task, following all the original requirements.`
              : workPrompt(issue, branch, taskRepo.pushRemote ?? taskRepo.remote ?? 'origin', taskRepo.remote ?? 'origin', taskRepo.prBase ?? taskRepo.defaultBranch, plan, current?.instructions, current?.verdict?.verification),
        cwd: worktree,
        callbacks: this.callbacks(id),
        model: store.get(id)?.model ?? this.cfg.model,
        resume: resumeSession,
        abortController: controller,
      });
      store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + work.costUsd });
      if (work.isError) throw new Error(`work failed: ${work.errors.join('; ')}`);

      const repoChecks = this.cfg.repos.find((r) => r.path === taskRepo.path)?.checks ?? this.cfg.checks;
      if (repoChecks.length) {
        store.setStatus(id, 'checks');
        store.addActivity(id, 'running checks');
        const results = await runChecks(repoChecks, worktree);
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
      store.update(id, { status: 'error', error: cancelled ? 'cancelled' : String(err) });
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
    repoCfg: { path: string; defaultBranch: string; remote?: string; worktreeRoot: string },
  ): Promise<{ worktree: string; branch: string }> {
    const { path: repo, defaultBranch, worktreeRoot } = repoCfg;
    const remote = repoCfg.remote ?? 'origin';
    const branch = issue.branchName || issue.identifier.toLowerCase();
    const worktree = join(worktreeRoot, issue.identifier);
    if (existsSync(worktree)) return { worktree, branch };

    mkdirSync(worktreeRoot, { recursive: true });
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

function triagePrompt(issue: LinearIssue, repoNames: string[], instructions?: string): string {
  return `You are triaging a Linear issue before implementation. Investigate the codebase (read-only — do not modify files) to judge scope.

${issueBlock(issue)}
${instructionsBlock(instructions)}

Decide one of:
- "do": clearly scoped, a single agent can complete it with one PR (or a small stack). Include a short implementation plan.
- "too_big": needs to be broken up into multiple issues. Explain why — AND include "subtasks": an ordered array of proposed sub-issues, each completable by one agent with one PR in ONE repository. Per subtask: title (actionable, self-contained), description (context + acceptance criteria, markdown — assume the reader has not seen this issue), optional priority (1 urgent … 4 low), repo (one of: ${repoNames.join(', ')}), and blockedBy (array of zero-based indices of subtasks that must land first). The user will review, edit selection, and approve these into Linear.
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
  issue: LinearIssue,
  branch: string,
  pushRemote: string,
  upstreamRemote: string,
  prBase: string,
  plan?: string,
  instructions?: string,
  verification?: Verification,
): string {
  const forked = pushRemote !== upstreamRemote;
  return `Implement this Linear issue. You are in a dedicated git worktree on branch "${branch}".

${issueBlock(issue)}
${instructionsBlock(instructions)}${plan ? `\nTriage plan (from an earlier investigation pass):\n${plan}\n` : ''}
Before writing any code, create ${SUBTASKS_FILE} in the worktree root: a short markdown checklist (3-8 items) of the subtasks needed to complete this issue. As you finish each subtask, immediately update its checkbox to [x]. Keep this file current — it drives a progress display. Never commit it (it is git-excluded).

Requirements:
- Follow the repository's CLAUDE.md conventions.
${verificationBlock(verification)}
- Commit with clear messages referencing ${issue.identifier}.
- Before opening the PR, spawn a subagent (Task tool) to review your full branch diff for bugs, missed edge cases, and convention violations. Address any real findings. Include this review as a subtask.
- Push the branch to the "${pushRemote}" remote${forked ? ` (a fork — the upstream is "${upstreamRemote}")` : ''} and open a DRAFT PR against ${prBase} of the upstream repo with "gh pr create --draft --base ${prBase}"${forked ? ' (gh handles fork PRs; pass --head <fork-owner>:<branch> if it asks)' : ''}, title prefixed with "${issue.identifier}:", body linking ${issue.url}.
- PRs stay DRAFT: never run "gh pr ready" or mark a PR ready for review — promoting a PR out of draft is always a human decision.
${forked ? '- Do NOT create stacked PRs: this repo uses a fork workflow and stacked PRs require pushing to the upstream. Keep it to a single PR.' : '- If the change is genuinely better split into stacked PRs, create stacked branches off this one and open a draft PR per layer, each based on the previous branch.'}
- If you get blocked on a decision only a human can make, use AskUserQuestion.`;
}

function ciFixPrompt(issue: LinearIssue, prs: Task['prs']): string {
  const prList = prs.map((pr) => `#${pr.number} (${pr.headRefName})`).join(', ');
  return `CI is failing on your draft PR(s) for ${issue.identifier}: ${prList}.

Diagnose and fix:
1. "gh pr checks <number>" to see which checks failed.
2. "gh run view <run-id> --log-failed" for the failing logs.
3. Fix the root cause in this worktree, run the relevant linters/tests locally, commit, and push.
4. If a failure is clearly unrelated flaky infrastructure (not your change), do not chase it — say so in your final message and stop.

PRs stay DRAFT: never run "gh pr ready" — promoting is a human decision.`;
}
