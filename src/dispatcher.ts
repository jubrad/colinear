import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { runChecks } from './checks.js';
import { pollPrs } from './prs.js';
import { store } from './store.js';
import type { Config, LinearIssue, Subtask, Task, TriageVerdict } from './types.js';

const exec = promisify(execFile);

const SUBTASKS_FILE = '.foreman-subtasks.md';

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['do', 'too_big', 'needs_info'] },
    reason: { type: 'string' },
    plan: { type: 'string' },
  },
  required: ['verdict', 'reason'],
  additionalProperties: false,
};

export class Dispatcher {
  private queue: string[] = [];
  private running = 0;

  constructor(private cfg: Config) {}

  enqueue(issues: LinearIssue[]) {
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
      };
      store.upsert(task);
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
    try {
      store.update(id, { status: 'triage', startedAt: Date.now() });
      store.addActivity(id, 'creating worktree');
      const { worktree, branch } = await this.ensureWorktree(issue);
      store.update(id, { worktree, branch });

      store.addActivity(id, 'triage pass');
      const triage = await runSession({
        prompt: triagePrompt(issue),
        cwd: worktree,
        callbacks: this.callbacks(id),
        outputSchema: TRIAGE_SCHEMA,
        model: this.cfg.model,
        maxTurns: 40,
      });
      store.update(id, { costUsd: (store.get(id)?.costUsd ?? 0) + triage.costUsd });
      if (triage.isError) throw new Error(`triage failed: ${triage.errors.join('; ')}`);

      const verdict = triage.structured as TriageVerdict;
      store.update(id, { verdict });
      if (verdict.verdict !== 'do') {
        store.setStatus(id, 'escalated');
        store.addActivity(id, `escalated (${verdict.verdict}): ${verdict.reason.slice(0, 100)}`);
        return;
      }

      store.setStatus(id, 'working');
      store.addActivity(id, 'work pass');
      stopSubtaskPoll = this.pollSubtasks(id, worktree);
      const work = await runSession({
        prompt: workPrompt(issue, branch, this.cfg.defaultBranch, verdict.plan),
        cwd: worktree,
        callbacks: this.callbacks(id),
        model: this.cfg.model,
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
      await pollPrs(this.cfg); // picks up the PR immediately and flips to pr_open
    } catch (err) {
      store.update(id, { status: 'error', error: String(err) });
      store.addActivity(id, `error: ${String(err).slice(0, 200)}`);
    } finally {
      stopSubtaskPoll?.();
      store.update(id, { endedAt: Date.now() });
    }
  }

  /** Agents maintain a checkbox list in .foreman-subtasks.md; poll and mirror it onto the card. */
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

function triagePrompt(issue: LinearIssue): string {
  return `You are triaging a Linear issue before implementation. Investigate the codebase (read-only — do not modify files) to judge scope.

${issueBlock(issue)}

Decide one of:
- "do": clearly scoped, a single agent can complete it with one PR (or a small stack). Include a short implementation plan.
- "too_big": needs to be broken up into a project with multiple issues. Explain why and sketch the breakdown.
- "needs_info": the issue is ambiguous or missing decisions only a human can make. State exactly what's missing.

Only use AskUserQuestion if a single quick answer would flip you from needs_info to do.`;
}

function workPrompt(issue: LinearIssue, branch: string, defaultBranch: string, plan?: string): string {
  return `Implement this Linear issue. You are in a dedicated git worktree on branch "${branch}".

${issueBlock(issue)}
${plan ? `\nTriage plan (from an earlier investigation pass):\n${plan}\n` : ''}
Before writing any code, create ${SUBTASKS_FILE} in the worktree root: a short markdown checklist (3-8 items) of the subtasks needed to complete this issue. As you finish each subtask, immediately update its checkbox to [x]. Keep this file current — it drives a progress display. Never commit it (it is git-excluded).

Requirements:
- Follow the repository's CLAUDE.md conventions.
- Always run the repository's linters and the relevant tests for the code you touch before committing. Include "run lints" and "run tests" as subtasks.
- Commit with clear messages referencing ${issue.identifier}.
- Before opening the PR, spawn a subagent (Task tool) to review your full branch diff for bugs, missed edge cases, and convention violations. Address any real findings. Include this review as a subtask.
- Push the branch and open a DRAFT PR against ${defaultBranch} with "gh pr create --draft", title prefixed with "${issue.identifier}:", body linking ${issue.url}. Always draft — a human marks it ready.
- If the change is genuinely better split into stacked PRs, create stacked branches off this one and open a draft PR per layer, each based on the previous branch.
- If you get blocked on a decision only a human can make, use AskUserQuestion.`;
}
