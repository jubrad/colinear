import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runSession } from './agent.js';
import { isDemo } from './demo.js';
import { guidanceFor } from './guidance.js';
import { log } from './log.js';
import { parseDoc, upsertFinding, REVIEW_FILE } from './reviewer.js';
import { store } from './store.js';
import type { Config, Severity, Task } from './types.js';

const exec = promisify(execFile);
const DIFF_LIMIT = 2_000_000;

/**
 * Reading your own agent's work before it becomes someone else's problem.
 *
 * This is the PR-review machinery pointed at a branch instead of a pull
 * request: the same document, the same ```findings fence, the same annotated
 * diff. What differs is where a finding goes — not to an author on GitHub, but
 * back to the agent that wrote the code, as work.
 *
 * Only offered on `pr_open`, which is the operator's own workflow (draft
 * first, read it, then promote) and also the only state where the diff holds
 * still: the agent is idle and everything it wrote is committed.
 */

/** The document lives in the task's worktree, exactly as a review's does. */
export const docPath = (task: Task): string | undefined =>
  task.worktree ? join(task.worktree, REVIEW_FILE) : undefined;

/**
 * What the agent has written, against the branch it started from. Read from
 * the worktree rather than GitHub: it is local, it is current, and it works
 * before anyone has fetched anything.
 */
export async function taskDiff(cfg: Config, task: Task): Promise<string> {
  if (!task.worktree) return '';
  const base = task.repo ? cfg.repos.find((r) => r.name === task.repo?.name)?.defaultBranch : undefined;
  const remote = 'origin';
  const against = base ? `${remote}/${base}` : 'HEAD~1';
  const { stdout } = await exec('git', ['-C', task.worktree, 'diff', `${against}...HEAD`], {
    maxBuffer: 32 * 1024 * 1024,
  }).catch(async () => {
    // an unfetched base, or a branch with no merge base yet
    const fallback = await exec('git', ['-C', task.worktree!, 'diff', 'HEAD~1...HEAD'], {
      maxBuffer: 32 * 1024 * 1024,
    }).catch(() => ({ stdout: '' }));
    return fallback;
  });
  return stdout.length > DIFF_LIMIT ? `${stdout.slice(0, DIFF_LIMIT)}\n\n[diff truncated]` : stdout;
}

/** Pull findings out of the document on disk and onto the card. */
export function absorb(task: Task): void {
  const path = docPath(task);
  if (!path || !existsSync(path)) return;
  const { findings } = parseDoc(readFileSync(path, 'utf8').slice(0, 200_000));
  store.update(task.issue.id, { findings });
}

/**
 * Review the branch with a **fresh** session.
 *
 * Deliberately not the agent that wrote the code: asked to review its own
 * work in its own context, it agrees with itself. A session that arrives cold,
 * reads the diff and reads around it is the only one whose "this looks fine"
 * means anything.
 */
export async function reviewTask(cfg: Config, task: Task): Promise<void> {
  const id = task.issue.id;
  if (!task.worktree) return;
  if (isDemo(cfg)) {
    store.addActivity(id, 'demo mode — no self-review session ran');
    return;
  }
  store.update(id, { reviewing: true });
  store.addActivity(id, 'reading its own work');
  try {
    const sha = await headSha(task.worktree);
    const result = await runSession({
      permissions: { mode: cfg.agentPermissionMode, deny: cfg.denyTools },
      agent: { kind: 'review', label: task.issue.identifier, origin: 'you asked for a self-review' },
      prompt: selfReviewPrompt(cfg, task),
      cwd: task.worktree,
      model: cfg.model,
      callbacks: {
        onActivity: (line) => store.addActivity(id, line),
        onSessionId: () => {},
        onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment and note it in the review')),
      },
    });
    absorb(store.get(id) ?? task);
    const count = store.get(id)?.findings?.length ?? 0;
    store.update(id, { reviewing: false, reviewedSha: sha });
    store.addActivity(
      id,
      count ? `self-review: ${count} finding${count === 1 ? '' : 's'}` : 'self-review found nothing to raise',
    );
    if (result.isError) store.addActivity(id, `self-review failed: ${result.errors.join('; ').slice(0, 120)}`);
  } catch (err) {
    store.update(id, { reviewing: false });
    store.addActivity(id, `self-review failed: ${String(err).slice(0, 120)}`);
    log(`self-review ${task.issue.identifier} failed: ${err}`);
  }
}

/**
 * Ask what a range of lines does, and write the answer where you asked.
 *
 * A short, focused session rather than a whole review: you are reading a diff
 * and one block is opaque. The answer lands as an `info` finding anchored to
 * that range, which means it appears in the margin beside the code and is
 * never posted — the same annotation the agent would have written unprompted,
 * asked for on demand.
 */
export async function explainLines(
  cfg: Config,
  task: Task,
  at: { file: string; startLine: number; endLine: number },
): Promise<void> {
  const id = task.issue.id;
  const path = docPath(task);
  if (!path || !task.worktree) return;
  if (isDemo(cfg)) {
    store.addActivity(id, 'demo mode — nothing was explained');
    return;
  }
  const where = at.startLine === at.endLine ? `line ${at.endLine}` : `lines ${at.startLine}–${at.endLine}`;
  store.addActivity(id, `asked what ${at.file} ${where} does`);
  try {
    await runSession({
      permissions: { mode: cfg.agentPermissionMode, deny: cfg.denyTools },
      agent: { kind: 'review', label: task.issue.identifier, origin: `you asked about ${at.file}:${at.endLine}` },
      prompt: explainPrompt(cfg, at, where),
      cwd: task.worktree,
      model: cfg.model,
      callbacks: {
        onActivity: (line) => store.addActivity(id, line),
        onSessionId: () => {},
        onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment')),
      },
    });
  } catch (err) {
    store.addActivity(id, `explain failed: ${String(err).slice(0, 120)}`);
  } finally {
    // whatever happened, read the document back: a partial answer is worth
    // more than a spinner that never stops
    absorb(store.get(id) ?? task);
  }
}

export function explainPrompt(
  cfg: Config,
  at: { file: string; startLine: number; endLine: number },
  where: string,
): string {
  return `The operator is reading a diff and wants to understand one part of it: **${at.file}, ${where}**.

Read those lines and enough of the code around them to explain them properly, then add ONE finding to the \`\`\`findings block in \`${REVIEW_FILE}\` in this directory — creating the file with a short prose header if it does not exist, and leaving every finding already in it exactly as it is.

The finding is:

\`\`\`json
{"file": "${at.file}", "line": ${at.endLine}${at.startLine !== at.endLine ? `, "startLine": ${at.startLine}` : ''}, "severity": "info", "comment": "…"}
\`\`\`

\`info\` is never posted anywhere — it annotates the code for the person reading the diff. So write what lets them judge it rather than a paraphrase: what this code is doing and why it is here, the invariant or assumption it rests on and where that is established, and anything they would otherwise have to go and find out for themselves. If the answer is genuinely "exactly what it looks like", say that in one line rather than padding it.

Change nothing else. Reply with one sentence.${guidanceFor(cfg.guidance, 'review')}`;
}

/** Edit, add or drop a finding — the same rewrite a PR review does. */
export function editFinding(
  task: Task,
  at: { file: string; line: number; startLine?: number },
  comment: string,
  severity?: Severity,
): void {
  const path = docPath(task);
  if (!path) return;
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const after = upsertFinding(before, at, comment, severity);
  if (after === before) return;
  writeFileSync(path, after);
  absorb(task);
}

/**
 * Hand the review back to the agent that wrote the code.
 *
 * Deterministic, like posting: the instruction is composed from the findings
 * rather than by a session, so what the agent is asked to do is what you read.
 * Annotations are left out — the agent wrote this code and does not need it
 * explained back, which is the same rule as never posting them to an author,
 * arrived at from the other direction.
 */
export function handBack(task: Task): { text: string; count: number } | undefined {
  const actionable = (task.findings ?? []).filter((f) => f.severity !== 'info');
  if (!actionable.length) return undefined;
  const lines = actionable.map((f) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'the change as a whole';
    return `- **${where}** (${f.severity ?? 'consider'}) — ${f.comment.trim()}`;
  });
  const text = [
    `I read the diff on your draft PR and left ${actionable.length} comment${actionable.length === 1 ? '' : 's'}.`,
    '',
    ...lines,
    '',
    `The same list is in \`${REVIEW_FILE}\` in your worktree, with any wording I changed.`,
    'Work through them: fix what should be fixed, and say so plainly where you disagree rather than',
    'making a change you think is wrong. Push to the same branch when you are done.',
  ].join('\n');
  return { text, count: actionable.length };
}

async function headSha(worktree: string): Promise<string | undefined> {
  const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', 'HEAD']).catch(() => ({ stdout: '' }));
  return stdout.trim() || undefined;
}

function selfReviewPrompt(cfg: Config, task: Task): string {
  return `You are reviewing a branch before its pull request is promoted out of draft. The code was written by another agent working the issue below; you did not write it, and your job is to read it as someone who has to decide whether it is safe to ship.

## The issue it was meant to solve
${task.issue.identifier}: ${task.issue.title}
${task.issue.description?.trim() ? `\n${task.issue.description.trim().slice(0, 4000)}\n` : ''}

## What to do
Read the diff (\`git diff\`, \`git log\`) and enough of the surrounding code to judge it in context — a diff alone hides most real problems. Ask the question the issue implies: does this change actually do what was asked, and what does it break? Do not modify any file except the review document below.

Write your review to \`${REVIEW_FILE}\` in the working directory (it is git-excluded). Prose first — what the change does and where your judgement is weakest — then a \`\`\`findings block: a JSON array, one object per finding, \`{"file", "line", "severity", "comment"}\`. \`line\` is a line in the new version of the file that the diff touches. \`severity\` is one of blocking, consider, nit, praise, or **info**.

Two of those matter especially here:

- **blocking** is for what must change before this ships. The operator reads these first and hands them straight back to the agent that wrote the code, so write each one as an instruction that agent can act on.
- **info** is never handed back: it annotates the code for the operator, who is about to read a diff they did not write. Give them what lets them judge it — the intent behind a hunk, the invariant it rests on and where that is established, what the change really changes when the diff looks larger or smaller than its effect, and what they should check themselves. Not a paraphrase of the lines.

Reply briefly; the document is the deliverable.${guidanceFor(cfg.guidance, 'review')}`;
}
