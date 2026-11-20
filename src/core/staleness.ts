import type { Review, Task } from './types.js';

/** The views that hide what has gone quiet, each with its own threshold. */
export type StaleView = 'board' | 'tasks' | 'reviews';

/** Days without an update before a view hides an item; 0 hides nothing. */
export type HideStaleDays = Record<StaleView, number>;

export const DEFAULT_HIDE_STALE_DAYS = 21;

/** `hideStaleDays` as written: one number for every view, or per view, with the rest defaulted. */
export function normalizeHideStale(raw: unknown): HideStaleDays {
  const days = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  if (typeof raw === 'number') {
    const all = days(raw, DEFAULT_HIDE_STALE_DAYS);
    return { board: all, tasks: all, reviews: all };
  }
  const given = raw && typeof raw === 'object' ? (raw as Partial<Record<StaleView, unknown>>) : {};
  return {
    board: days(given.board, DEFAULT_HIDE_STALE_DAYS),
    tasks: days(given.tasks, DEFAULT_HIDE_STALE_DAYS),
    reviews: days(given.reviews, DEFAULT_HIDE_STALE_DAYS),
  };
}

const RUNNING: Task['status'][] = ['triage', 'working', 'checks'];

/**
 * When a task was last updated: a session starting or ending, or its work
 * changing. Opening it is not an update — it would make anything you glance
 * at fresh again. Undefined for a task with nothing to date it by (queued and
 * never started), which is never called stale.
 */
export function taskUpdatedAt(task: Task): number | undefined {
  const at = Math.max(task.endedAt ?? 0, task.startedAt ?? 0, task.changes?.movedAt ?? 0);
  return at || undefined;
}

export function taskIsStale(task: Task, days: number, now: number): boolean {
  if (!days || RUNNING.includes(task.status)) return false;
  const at = taskUpdatedAt(task);
  return at !== undefined && now - at > days * 86_400_000;
}

/**
 * When a review was last updated: GitHub's own `updatedAt` for the PR (a
 * push, a comment, a review — yours included), or colinear's review of it
 * ending, whichever is later.
 */
export function reviewUpdatedAt(review: Review): number | undefined {
  const at = Math.max(Date.parse(review.updatedAt) || 0, review.endedAt ?? 0);
  return at || undefined;
}

export function reviewIsStale(review: Review, days: number, now: number): boolean {
  if (!days || review.status === 'reviewing' || review.status === 'queued' || review.status === 'posting') return false;
  const at = reviewUpdatedAt(review);
  return at !== undefined && now - at > days * 86_400_000;
}
