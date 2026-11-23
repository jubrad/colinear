import { log } from './log.js';
import { store } from './store.js';
import type { Config, Review, ReviewFinding, Task } from './types.js';

/**
 * The review loop for a task's own PR: colinear reviews what its agent
 * opened, hands the findings back to that agent, and reviews again once it
 * has pushed — so the agent gets a second reader without anyone carrying
 * the comments across by hand.
 *
 * Driven by the review poll rather than events: the PR's review record
 * appears on a poll (adoptTaskPrs), its head moves on a poll, and a review
 * or a revision finishing is store state the next sweep reads. A minute of
 * latency between steps is nothing next to a review session's length.
 *
 * Nothing here reaches GitHub. The findings go to the task's agent as its
 * next turn (the same path `:diff`'s hand-back takes); posting stays the
 * operator's call.
 */

/** What the loop may ask of the rest of the daemon. */
export interface TaskReviewDeps {
  startReview: (id: string) => void;
  /** a revision turn for an idle task on an open PR; false when it is not idle */
  revise: (taskId: string, text: string) => boolean;
}

const ACTIVE: Review['status'][] = ['reviewing', 'queued', 'posting'];

/** Findings the agent should act on: not annotations for the operator, not praise. */
export function actionable(findings: ReviewFinding[] | undefined): ReviewFinding[] {
  return (findings ?? []).filter((f) => f.severity !== 'info' && f.severity !== 'praise' && f.comment?.trim());
}

/** A task with nothing running on it, its PR open: the only time it can take a turn. */
function idle(task: Task | undefined): task is Task {
  return Boolean(task && task.status === 'pr_open' && !task.maintenance);
}

/** The turn the task's agent gets: what the review found, and what happens next. */
export function handBackText(review: Review, findings: ReviewFinding[], round: number, maxRounds: number): string {
  const lines = findings.map((f) => {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'the change as a whole';
    return `- **${where}** (${f.severity ?? 'consider'}) — ${f.comment.trim()}`;
  });
  const next =
    round < maxRounds
      ? 'Once you push, colinear reviews the PR again.'
      : 'This was the last automatic round; the operator reads the rest.';
  return [
    `colinear reviewed your PR (${review.repository}#${review.number}, round ${round} of ${maxRounds}) and left ${findings.length} comment${findings.length === 1 ? '' : 's'}.`,
    '',
    ...lines,
    '',
    'Work through them: fix what should be fixed, and say so plainly where you disagree rather than making a change you think is wrong. Push to the same branch when you are done.',
    next,
  ].join('\n');
}

/**
 * One sweep over every task PR on the review list. Each review is in one of
 * three places, and moves on from there:
 *
 * - **not reviewed at this head yet**, with rounds left and its task idle:
 *   start a review. The first round needs nothing else; a later one needs the
 *   agent to have pushed since the last hand-back.
 * - **reviewed, findings not yet handed back**: hand the actionable ones to
 *   the task, or note that there were none.
 * - anything else — a review running, the task busy, rounds spent — waits.
 */
export function sweepTaskReviews(cfg: Config, deps: TaskReviewDeps): void {
  if (!cfg.taskReviews.auto) return;
  const max = cfg.taskReviews.maxRounds;
  for (const review of store.listReviews()) {
    if (!review.task || review.status === 'stale' || review.hidden || ACTIVE.includes(review.status)) continue;
    if (!review.repo) continue; // nowhere to check it out; the import path heals this
    const task = store.list().find((t) => t.issue.identifier === review.task);
    if (!task) continue;
    const rounds = review.autoRounds ?? 0;

    // a finished review whose findings the task has not had yet
    if (review.status === 'ready' && review.reviewedSha && review.handedSha !== review.reviewedSha && rounds > 0) {
      if (!idle(task)) continue; // mid-revision or running checks: hand it over when it stops
      const findings = actionable(review.findings);
      if (!findings.length) {
        store.updateReview(review.id, { handedSha: review.reviewedSha });
        store.addReviewActivity(review.id, `round ${rounds}: nothing for ${task.issue.identifier} to change`);
        store.addActivity(task.issue.id, `colinear reviewed its PR (round ${rounds}): nothing to change`);
        continue;
      }
      if (deps.revise(task.issue.id, handBackText(review, findings, rounds, max))) {
        store.updateReview(review.id, { handedSha: review.reviewedSha });
        store.addReviewActivity(review.id, `round ${rounds}: ${findings.length} comment${findings.length === 1 ? '' : 's'} handed to ${task.issue.identifier}`);
        log(`task review: ${review.id} round ${rounds} handed to ${task.issue.identifier} (${findings.length})`);
      }
      continue;
    }

    // a head that has not been reviewed: the first round, or a push after a hand-back
    if (rounds >= max || !idle(task) || !review.headSha || review.reviewedSha === review.headSha) continue;
    // a round that never got as far as a hand-back (it failed, or the operator
    // took it over) is not retried on its own: `r` is the operator's
    if (rounds > 0 && review.handedSha === undefined) continue;
    store.updateReview(review.id, { autoRounds: rounds + 1 });
    store.addReviewActivity(review.id, `round ${rounds + 1} of ${max}: reviewing ${task.issue.identifier}'s PR automatically`);
    deps.startReview(review.id);
  }
}
