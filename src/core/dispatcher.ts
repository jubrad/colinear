import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { runChecks } from './checks.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { pollPrs } from './prs.js';
import { syncIssueState } from './statesync.js';
import { store } from './store.js';
import type { Config, LinearIssue, Subtask, Task, TriageVerdict, Verification } from './types.js';

const exec = promisify(execFile);

const SUBTASKS_FILE = '.colinear-subtasks.md';

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['do', 'too_big', 'needs_info'] },
    reason: { type: 'string' },
    plan: { type: 'string' },
    verification: { type: 'string', enum: ['local-light', 'ci', 'needs-env'] },
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

  constructor(private cfg: Config) {}

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
    if (!task || !['interrupted', 'error', 'escalated'].includes(task.status)) return;
    store.update(id, { status: 'queued', error: undefined, endedAt: undefined });
    store.addActivity(id, task.sessionId ? 'resuming session' : 'restarting');
    this.queue.push(id);
    this.pump();
  }

  enqueue(issues: LinearIssue[], instructions?: string) {
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
        instructions,
      };
      store.upsert(task);
      if (instructions) store.addActivity(issue.id, `instructions: ${instructions.slice(0, 100)}`);
      this.queue.push(issue.id);
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
      const { worktree, branch } = await this.ensureWorktree(issue);
      store.update(id, { worktree, branch });

      let plan: string | undefined;
      if (!resumeSession) {
        void syncIssueState(this.cfg, issue, 'started');
        store.addActivity(id, 'triage pass');
        const triage = await runSession({
          prompt: triagePrompt(issue, store.get(id)?.instructions),
          cwd: worktree,
          callbacks: this.callbacks(id),
          outputSchema: TRIAGE_SCHEMA,
          model: this.cfg.model,
          maxTurns: 40,
          abortController: controller,
        });
        store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + triage.costUsd });
        if (triage.isError) throw new Error(`triage failed: ${triage.errors.join('; ')}`);

        const verdict = triage.structured as TriageVerdict;
        store.update(id, { verdict });
        if (verdict.verification) store.addActivity(id, `verification: ${verdict.verification}`);
        if (verdict.verdict !== 'do') {
          store.setStatus(id, 'escalated');
          store.addActivity(id, `escalated (${verdict.verdict}): ${verdict.reason.slice(0, 100)}`);
          notify(this.cfg, issue.identifier, `escalated: ${verdict.verdict}`, issue.url);
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
              : workPrompt(issue, branch, this.cfg.defaultBranch, plan, current?.instructions, current?.verdict?.verification),
        cwd: worktree,
        callbacks: this.callbacks(id),
        model: this.cfg.model,
        resume: resumeSession,
        abortController: controller,
      });
      store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + work.costUsd });
      if (work.isError) throw new Error(`work failed: ${work.errors.join('; ')}`);

      if (this.cfg.checks.length) {
        store.setStatus(id, 'checks');
        store.addActivity(id, 'running checks');
        const results = await runChecks(this.cfg.checks, worktree);
        store.update(id, { checks: results });
      }

      store.setStatus(id, 'done');
      await pollPrs(this.cfg, this); // picks up the PR immediately and flips to pr_open
      notify(this.cfg, issue.identifier, 'agent finished', store.get(id)?.prs[0]?.url ?? issue.url);
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

  private async ensureWorktree(issue: LinearIssue): Promise<{ worktree: string; branch: string }> {
    const { repo, defaultBranch, worktreeRoot } = this.cfg;
    const branch = issue.branchName || issue.identifier.toLowerCase();
    const worktree = join(worktreeRoot, issue.identifier);
    if (existsSync(worktree)) return { worktree, branch };

    mkdirSync(worktreeRoot, { recursive: true });
    await exec('git', ['-C', repo, 'fetch', 'origin', defaultBranch]);
    try {
      await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch, `origin/${defaultBranch}`]);
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

function triagePrompt(issue: LinearIssue, instructions?: string): string {
  return `You are triaging a Linear issue before implementation. Investigate the codebase (read-only — do not modify files) to judge scope.

${issueBlock(issue)}
${instructionsBlock(instructions)}

Decide one of:
- "do": clearly scoped, a single agent can complete it with one PR (or a small stack). Include a short implementation plan.
- "too_big": needs to be broken up into a project with multiple issues. Explain why and sketch the breakdown.
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
  defaultBranch: string,
  plan?: string,
  instructions?: string,
  verification?: Verification,
): string {
  return `Implement this Linear issue. You are in a dedicated git worktree on branch "${branch}".

${issueBlock(issue)}
${instructionsBlock(instructions)}${plan ? `\nTriage plan (from an earlier investigation pass):\n${plan}\n` : ''}
Before writing any code, create ${SUBTASKS_FILE} in the worktree root: a short markdown checklist (3-8 items) of the subtasks needed to complete this issue. As you finish each subtask, immediately update its checkbox to [x]. Keep this file current — it drives a progress display. Never commit it (it is git-excluded).

Requirements:
- Follow the repository's CLAUDE.md conventions.
${verificationBlock(verification)}
- Commit with clear messages referencing ${issue.identifier}.
- Before opening the PR, spawn a subagent (Task tool) to review your full branch diff for bugs, missed edge cases, and convention violations. Address any real findings. Include this review as a subtask.
- Push the branch and open a DRAFT PR against ${defaultBranch} with "gh pr create --draft", title prefixed with "${issue.identifier}:", body linking ${issue.url}.
- PRs stay DRAFT: never run "gh pr ready" or mark a PR ready for review — promoting a PR out of draft is always a human decision.
- If the change is genuinely better split into stacked PRs, create stacked branches off this one and open a draft PR per layer, each based on the previous branch.
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
