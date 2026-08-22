import type { PendingQuestion, ProjectPlan, Review, Task } from './types.js';

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
  | { kind: 'review-activity'; id: string; line: string }
  | { kind: 'plan-upsert'; plan: WirePlan }
  | { kind: 'plan-update'; id: string; patch: Partial<WirePlan>; clear: string[] }
  | { kind: 'plan-activity'; id: string; line: string }
  /** dropped by retention (tasks/reviews) or the operator (plans) — the only
      ways a row ever leaves the store */
  | { kind: 'delete'; id: string }
  | { kind: 'review-delete'; id: string }
  | { kind: 'plan-delete'; id: string };

/** A change stamped with the version it produced. */
export type Delta = Change & { v: number };

/** A task on the wire: the question set travels, never its callback. */
export type WireTask = Omit<Task, 'question'> & {
  question?: Omit<PendingQuestion, 'answer'>;
};

export type WirePatch = Partial<WireTask>;

/** Same treatment for reviews: the pending question loses its callback. */
export type WireReview = Omit<Review, 'question'> & {
  question?: Omit<PendingQuestion, 'answer'>;
};

export type WirePlan = Omit<ProjectPlan, 'question'> & {
  question?: Omit<PendingQuestion, 'answer'>;
};

export interface Snapshot {
  version: number;
  tasks: WireTask[];
  reviews: WireReview[];
  plans: WirePlan[];
}

/** Drop the answer callback; everything else on a task, review or plan is JSON. */
export function toWire<T extends Partial<Task> | Partial<Review> | Partial<ProjectPlan>>(
  value: T,
): Omit<T, 'question'> & { question?: Omit<PendingQuestion, 'answer'> } {
  const { question, ...rest } = value;
  const wire = structuredClone(rest) as Omit<T, 'question'> & { question?: Omit<PendingQuestion, 'answer'> };
  if (question) wire.question = { questions: structuredClone(question.questions), kind: question.kind };
  return wire;
}

/**
 * Split a patch into serializable fields and the keys it clears. JSON drops
 * `undefined`, but callers rely on `{ error: undefined }` meaning "clear it",
 * so those keys travel separately.
 */
export function encodePatch<T extends Partial<Task> | Partial<Review> | Partial<ProjectPlan>>(
  patch: T,
): { patch: Omit<T, 'question'> & { question?: Omit<PendingQuestion, 'answer'> }; clear: string[] } {
  const clear: string[] = [];
  const keep: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) clear.push(key);
    else keep[key] = value;
  }
  return { patch: toWire(keep as T), clear };
}
