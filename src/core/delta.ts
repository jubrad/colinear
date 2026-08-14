import type { Review, Task } from './types.js';

/**
 * Change data capture for the task store.
 *
 * Every mutation emits one delta stamped with the version it produced, so a
 * mirror can be brought up to date with a snapshot plus the deltas after it.
 * `version` is the LSN: deltas must be applied in order, and a gap means the
 * mirror has to re-snapshot.
 */
export type Change =
  | { kind: 'upsert'; task: WireTask }
  | { kind: 'update'; id: string; patch: WirePatch; clear: string[] }
  | { kind: 'activity'; id: string; line: string }
  | { kind: 'review-upsert'; review: WireReview }
  | { kind: 'review-update'; id: string; patch: Partial<WireReview>; clear: string[] }
  | { kind: 'review-activity'; id: string; line: string };

/** A change stamped with the version it produced. */
export type Delta = Change & { v: number };

/** A task on the wire: the pending question keeps its text, never its callback. */
export type WireTask = Omit<Task, 'question'> & {
  question?: { text: string; options: string[] };
};

export type WirePatch = Partial<WireTask>;

/** Same treatment for reviews: the pending question loses its callback. */
export type WireReview = Omit<Review, 'question'> & {
  question?: { text: string; options: string[] };
};

export interface Snapshot {
  version: number;
  tasks: WireTask[];
  reviews: WireReview[];
}

/** Drop the answer callback; everything else on a task or review is JSON. */
export function toWire<T extends Partial<Task> | Partial<Review>>(
  value: T,
): Partial<WireTask> & Partial<WireReview> {
  const { question, ...rest } = value;
  const wire = structuredClone(rest) as Partial<WireTask> & Partial<WireReview>;
  if (question) wire.question = { text: question.text, options: [...question.options] };
  return wire;
}

/**
 * Split a patch into serializable fields and the keys it clears. JSON drops
 * `undefined`, but callers rely on `{ error: undefined }` meaning "clear it",
 * so those keys travel separately.
 */
export function encodePatch(
  patch: Partial<Task> | Partial<Review>,
): { patch: WirePatch & Partial<WireReview>; clear: string[] } {
  const clear: string[] = [];
  const keep: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) clear.push(key);
    else keep[key] = value;
  }
  return { patch: toWire(keep), clear };
}
