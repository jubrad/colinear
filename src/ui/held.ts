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

/** Where the item at `pos` in `before` is in `after`, by key; `pos` itself when it is gone. */
export function followPos<T>(
  before: ReadonlyArray<readonly T[]>,
  pos: { col: number; row: number },
  after: ReadonlyArray<readonly T[]>,
  keyOf: (t: T) => string,
): { col: number; row: number } {
  const col = before[pos.col];
  const was = col?.[Math.min(pos.row, col.length - 1)];
  if (was === undefined) return pos;
  const key = keyOf(was);
  for (let c = 0; c < after.length; c++) {
    const r = after[c].findIndex((t) => keyOf(t) === key);
    if (r !== -1) return { col: c, row: r };
  }
  return pos;
}

/**
 * useHeldIndex for a grid — the board's columns of cards. The board re-sorts
 * as agents work (most recently touched first) and cards change columns, so
 * a column and row held across that named whichever card moved into the
 * slot: `s` attached to a parent's session from its child's card. This keeps
 * the position on the card.
 */
export function useHeldPos<T>(
  grid: ReadonlyArray<readonly T[]>,
  pos: { col: number; row: number },
  setPos: (p: { col: number; row: number }) => void,
  keyOf: (t: T) => string,
): { col: number; row: number } {
  const last = useRef({ grid, pos });
  let at = pos;
  const samePos = last.current.pos.col === pos.col && last.current.pos.row === pos.row;
  if (last.current.grid !== grid && samePos) at = followPos(last.current.grid, pos, grid, keyOf);
  last.current = { grid, pos: at };
  if (at.col !== pos.col || at.row !== pos.row) setPos(at);
  return at;
}
