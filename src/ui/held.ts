import { useRef } from 'react';

/**
 * Where the item that was at `idx` in `before` is in `after` — or `idx` itself
 * when it is gone, so a row that leaves the list hands the cursor to its
 * neighbour rather than to the top.
 */
export function follow<T>(before: readonly T[], idx: number, after: readonly T[], keyOf: (t: T) => string): number {
  const was = before[Math.min(idx, before.length - 1)];
  if (was === undefined) return idx;
  const key = keyOf(was);
  const now = after.findIndex((t) => keyOf(t) === key);
  return now === -1 ? idx : now;
}

/**
 * A cursor index that stays on its item when the list re-orders under it.
 *
 * Lists here are re-sorted by data that arrives on its own — a poll, a review
 * finishing, a finding edited — and an index held across that names whatever
 * moved into its slot: the preview, and anything opened from it, switched to
 * another PR with no key pressed. This follows the item instead. A move made
 * in the same render as the list changing (a reset to the top on a new sort)
 * is a choice, and is honoured.
 *
 * Returns the index to use this render; when it differs from `idx`, it has
 * already asked `setIdx` for it.
 */
export function useHeldIndex<T>(items: readonly T[], idx: number, setIdx: (i: number) => void, keyOf: (t: T) => string): number {
  const last = useRef({ items, idx });
  let at = idx;
  if (last.current.items !== items && last.current.idx === idx) at = follow(last.current.items, idx, items, keyOf);
  last.current = { items, idx: at };
  if (at !== idx) setIdx(at);
  return at;
}
