import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Config, ProjectPlan, Review, Task } from './types.js';

const exec = promisify(execFile);

export interface Reclaimable {
  path: string;
  /** the repo whose worktree list owns it */
  repoPath: string;
  kilobytes: number;
  /** what it belonged to, and why it can go */
  label: string;
  reason: 'done' | 'cancelled' | 'orphan' | 'review';
  ageDays: number;
}

const DAY = 24 * 60 * 60 * 1000;

async function sizeKb(path: string): Promise<number> {
  const { stdout } = await exec('du', ['-sk', path]).catch(() => ({ stdout: '0' }));
  return Number.parseInt(stdout.split(/\s+/)[0], 10) || 0;
}

/**
 * Worktrees that can go: those belonging to finished tasks, review checkouts,
 * and ones no task claims at all — repo re-routes and removed tasks leave
 * those behind, and nothing else ever cleans them up.
 *
 * `olderThanDays` guards the finished ones only. A worktree is often exactly
 * what you want the day a task completes; an orphan is never wanted.
 */
export async function findReclaimable(
  cfg: Config,
  tasks: Task[],
  reviews: Review[],
  /** a plan's design-session checkout is live until the operator drops the plan */
  plans: ProjectPlan[],
  olderThanDays: number,
  /** `du` over a 60G checkout is slow; skip it when only the list matters */
  opts?: { sizes?: boolean },
): Promise<Reclaimable[]> {
  const byWorktree = new Map<string, Task>();
  for (const task of tasks) if (task.worktree) byWorktree.set(task.worktree, task);
  // a review you're still working through owns its checkout, however new the
  // directory looks — only a stale review (merged, closed, taken) releases it
  const reviewWorktrees = new Map<string, Review>();
  for (const review of reviews) if (review.worktree) reviewWorktrees.set(review.worktree, review);
  // a plan's worktree belongs to a conversation the operator can return to at
  // any time; it is reclaimable when the plan is removed, not before
  const planWorktrees = new Set(plans.map((p) => p.worktree).filter(Boolean) as string[]);

  // An empty task list can't be told apart from "state didn't load", and in
  // that state every live worktree looks orphaned. Only worktrees we can name
  // positively — those of stale reviews — are safe to offer.
  const stateKnown = tasks.length > 0;

  const found: Reclaimable[] = [];
  for (const repo of cfg.repos) {
    if (!existsSync(repo.worktreeRoot)) continue;
    for (const name of readdirSync(repo.worktreeRoot)) {
      const path = join(repo.worktreeRoot, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      // clamp: a directory written this instant can time-stamp a hair ahead of
      // the clock, and a negative age reads as "younger than any threshold"
      const ageDays = Math.max(0, (Date.now() - stat.mtimeMs) / DAY);
      const task = byWorktree.get(path);

      if (planWorktrees.has(path)) continue; // a plan's design session lives here

      const review = reviewWorktrees.get(path);
      if (review && review.status !== 'stale') continue; // a review still in play

      let reason: Reclaimable['reason'] | undefined;
      let label: string;
      if (!task && !stateKnown && !review) continue; // can't prove it's dead
      if (!task) {
        reason = name.startsWith('review-') ? 'review' : 'orphan';
        label = review
          ? `${review.repository.split('/')[1] ?? review.repository}#${review.number}`
          : name.startsWith('review-')
            ? `review ${name.slice(7)}`
            : '(no task)';
      } else if (task.status === 'done' || task.status === 'cancelled') {
        if (ageDays < olderThanDays) continue; // finished, but still fresh enough to want
        reason = task.status;
        label = task.issue.identifier;
      } else {
        continue; // live work
      }

      const kilobytes = opts?.sizes === false ? 0 : await sizeKb(path);
      found.push({ path, repoPath: repo.path, kilobytes, label, reason, ageDays });
    }
  }
  return found.sort((a, b) => b.kilobytes - a.kilobytes);
}

/**
 * Remove one worktree through git, so its administrative entry goes too.
 * Throws if the directory is still there afterwards — the caller reports
 * per-item success, and counting a failure as reclaimed space is a lie.
 */
export async function removeWorktree(item: Reclaimable): Promise<void> {
  await exec('git', ['-C', item.repoPath, 'worktree', 'remove', '--force', item.path], {
    maxBuffer: 4 * 1024 * 1024,
  }).catch(async () => {
    // not a registered worktree (a stale directory): drop it directly
    await exec('rm', ['-rf', item.path]);
  });
  await exec('git', ['-C', item.repoPath, 'worktree', 'prune']).catch(() => {});
  if (existsSync(item.path)) throw new Error(`${item.path} is still present after removal`);
}

export const formatSize = (kb: number): string =>
  kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;
