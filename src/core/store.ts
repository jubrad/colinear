import {
  encodePatch,
  toWire,
  type Change,
  type Delta,
  type Snapshot,
  type WirePlan,
  type WireReview,
  type WireTask,
} from './delta.js';
import type { ProjectPlan, Review, Task, TaskStatus } from './types.js';

type Listener = () => void;

/** how many deltas a mirror can fall behind before it needs a fresh snapshot */
const LOG_LIMIT = 1000;

class Store {
  tasks = new Map<string, Task>();
  /** PR reviews, keyed "owner/repo#number" — same CDC contract as tasks */
  reviews = new Map<string, Review>();
  /** project plans, keyed by project id — same CDC contract again */
  plans = new Map<string, ProjectPlan>();
  version = 0;
  private listeners = new Set<Listener>();
  private log: Delta[] = [];
  /** set on a mirror: rebuilds the answer callback stripped for the wire */
  private onAnswer?: (id: string, answers: string[]) => void;
  /**
   * Set on a mirror: writes are forwarded to the owner instead of applied
   * locally, and come back as deltas. Views keep calling store.update() —
   * they don't know whether they're holding the real store or a mirror.
   */
  private remote?: (change: Change) => void;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  /** Record the change, then wake the listeners. */
  private emit(change: Change) {
    this.version++;
    this.log.push({ ...change, v: this.version });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.notify();
  }

  upsert(task: Task) {
    const change: Change = { kind: 'upsert', task: toWire(task) as WireTask };
    if (this.remote) return this.remote(change);
    this.tasks.set(task.issue.id, task);
    this.emit(change);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, patch: Partial<Task>) {
    const { patch: wire, clear } = encodePatch(patch);
    if (this.remote) return this.remote({ kind: 'update', id, patch: wire, clear });
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, patch);
    this.emit({ kind: 'update', id, patch: wire, clear });
  }

  setStatus(id: string, status: TaskStatus) {
    this.update(id, { status });
  }

  addActivity(id: string, line: string) {
    if (this.remote) return this.remote({ kind: 'activity', id, line });
    const task = this.tasks.get(id);
    if (!task) return;
    appendActivity(task, line);
    this.emit({ kind: 'activity', id, line });
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }

  upsertReview(review: Review) {
    const change: Change = { kind: 'review-upsert', review: toWire(review) as WireReview };
    if (this.remote) return this.remote(change);
    this.reviews.set(review.id, review);
    this.emit(change);
  }

  getReview(id: string): Review | undefined {
    return this.reviews.get(id);
  }

  updateReview(id: string, patch: Partial<Review>) {
    const { patch: wire, clear } = encodePatch(patch);
    if (this.remote) return this.remote({ kind: 'review-update', id, patch: wire, clear });
    const review = this.reviews.get(id);
    if (!review) return;
    Object.assign(review, patch);
    this.emit({ kind: 'review-update', id, patch: wire, clear });
  }

  addReviewActivity(id: string, line: string) {
    if (this.remote) return this.remote({ kind: 'review-activity', id, line });
    const review = this.reviews.get(id);
    if (!review) return;
    appendActivity(review, line);
    this.emit({ kind: 'review-activity', id, line });
  }

  /** Forget a task entirely. Retention is the only caller; nothing undoes it. */
  delete(id: string) {
    if (this.remote) return this.remote({ kind: 'delete', id });
    if (!this.tasks.delete(id)) return;
    this.emit({ kind: 'delete', id });
  }

  deleteReview(id: string) {
    if (this.remote) return this.remote({ kind: 'review-delete', id });
    if (!this.reviews.delete(id)) return;
    this.emit({ kind: 'review-delete', id });
  }

  listReviews(): Review[] {
    return [...this.reviews.values()];
  }

  upsertPlan(plan: ProjectPlan) {
    const change: Change = { kind: 'plan-upsert', plan: toWire(plan) as WirePlan };
    if (this.remote) return this.remote(change);
    this.plans.set(plan.id, plan);
    this.emit(change);
  }

  getPlan(id: string): ProjectPlan | undefined {
    return this.plans.get(id);
  }

  updatePlan(id: string, patch: Partial<ProjectPlan>) {
    const { patch: wire, clear } = encodePatch(patch);
    if (this.remote) return this.remote({ kind: 'plan-update', id, patch: wire, clear });
    const plan = this.plans.get(id);
    if (!plan) return;
    Object.assign(plan, patch);
    this.emit({ kind: 'plan-update', id, patch: wire, clear });
  }

  addPlanActivity(id: string, line: string) {
    if (this.remote) return this.remote({ kind: 'plan-activity', id, line });
    const plan = this.plans.get(id);
    if (!plan) return;
    appendActivity(plan, line);
    this.emit({ kind: 'plan-activity', id, line });
  }

  /** Plans leave only when the operator removes one; nothing sweeps them. */
  deletePlan(id: string) {
    if (this.remote) return this.remote({ kind: 'plan-delete', id });
    if (!this.plans.delete(id)) return;
    this.emit({ kind: 'plan-delete', id });
  }

  listPlans(): ProjectPlan[] {
    return [...this.plans.values()];
  }

  snapshot(): Snapshot {
    return {
      version: this.version,
      tasks: this.list().map((t) => toWire(t) as WireTask),
      reviews: this.listReviews().map((r) => toWire(r) as WireReview),
      plans: this.listPlans().map((p) => toWire(p) as WirePlan),
    };
  }

  /**
   * Deltas after `version`, or null when the mirror has fallen off the back of
   * the log and needs a snapshot instead.
   */
  since(version: number): Delta[] | null {
    if (version === this.version) return [];
    if (version > this.version) return null; // mirror ahead: only a stale daemon does this
    const oldest = this.log[0];
    if (!oldest || oldest.v > version + 1) return null;
    return this.log.filter((d) => d.v > version);
  }

  /**
   * Turn this store into a mirror: writes forward to the owner, and the
   * pending-question callback round-trips instead of running locally.
   */
  attach(remote: (change: Change) => void, onAnswer: (id: string, answers: string[]) => void) {
    this.remote = remote;
    this.onAnswer = onAnswer;
  }

  /** Apply a change locally (daemon side, on behalf of a client). */
  applyChange(change: Change) {
    const withCleared = <T>(patch: object, clear: string[]): T => {
      const out = { ...patch } as Record<string, unknown>;
      for (const key of clear) out[key] = undefined;
      return out as T;
    };
    switch (change.kind) {
      case 'upsert':
        return this.upsert(change.task as unknown as Task);
      case 'activity':
        return this.addActivity(change.id, change.line);
      case 'update':
        return this.update(change.id, withCleared<Partial<Task>>(change.patch, change.clear));
      case 'review-upsert':
        return this.upsertReview(change.review as unknown as Review);
      case 'review-activity':
        return this.addReviewActivity(change.id, change.line);
      case 'review-update':
        return this.updateReview(change.id, withCleared<Partial<Review>>(change.patch, change.clear));
      case 'plan-upsert':
        return this.upsertPlan(change.plan as unknown as ProjectPlan);
      case 'plan-activity':
        return this.addPlanActivity(change.id, change.line);
      case 'plan-update':
        return this.updatePlan(change.id, withCleared<Partial<ProjectPlan>>(change.patch, change.clear));
      case 'plan-delete':
        return this.deletePlan(change.id);
      case 'delete':
        return this.delete(change.id);
      case 'review-delete':
        return this.deleteReview(change.id);
    }
  }

  /** Mirror side: replace all state with a snapshot. */
  hydrate(snapshot: Snapshot, onAnswer?: (id: string, answers: string[]) => void) {
    if (onAnswer) this.onAnswer = onAnswer;
    this.tasks = new Map(snapshot.tasks.map((t) => [t.issue.id, this.fromWire(t, t.issue.id)]));
    this.reviews = new Map(snapshot.reviews.map((r) => [r.id, this.fromWire(r, r.id) as unknown as Review]));
    // older daemons don't send plans; an empty map beats a crash mid-hydrate
    this.plans = new Map((snapshot.plans ?? []).map((p) => [p.id, this.fromWire(p, p.id) as unknown as ProjectPlan]));
    this.version = snapshot.version;
    this.log = [];
    this.notify();
  }

  /**
   * Mirror side: apply one delta. Returns false when it doesn't follow the
   * mirror's current version — the caller re-snapshots rather than diverging.
   */
  apply(delta: Delta): boolean {
    if (delta.v !== this.version + 1) return false;
    if (delta.kind === 'delete') {
      this.tasks.delete(delta.id);
    } else if (delta.kind === 'review-delete') {
      this.reviews.delete(delta.id);
    } else if (delta.kind === 'plan-delete') {
      this.plans.delete(delta.id);
    } else if (delta.kind === 'upsert') {
      this.tasks.set(delta.task.issue.id, this.fromWire(delta.task, delta.task.issue.id));
    } else if (delta.kind === 'review-upsert') {
      this.reviews.set(delta.review.id, this.fromWire(delta.review, delta.review.id) as unknown as Review);
    } else if (delta.kind === 'plan-upsert') {
      this.plans.set(delta.plan.id, this.fromWire(delta.plan, delta.plan.id) as unknown as ProjectPlan);
    } else {
      const target = delta.kind.startsWith('review-')
        ? this.reviews.get(delta.id)
        : delta.kind.startsWith('plan-')
          ? this.plans.get(delta.id)
          : this.tasks.get(delta.id);
      if (!target) return false;
      if (delta.kind === 'activity' || delta.kind === 'review-activity' || delta.kind === 'plan-activity') {
        appendActivity(target, delta.line);
      } else {
        Object.assign(target, this.fromWire(delta.patch, delta.id));
        for (const key of delta.clear) (target as unknown as Record<string, unknown>)[key] = undefined;
      }
    }
    this.version = delta.v;
    this.notify();
    return true;
  }

  /** Re-attach the answer callback the wire format can't carry. */
  private fromWire(wire: Partial<WireTask> | Partial<WireReview> | Partial<WirePlan>, id: string): Task {
    const task = wire as unknown as Task;
    if (wire.question) {
      const send = this.onAnswer;
      task.question = {
        ...wire.question,
        answer: (answers: string[]) => send?.(id, answers),
      };
    }
    return task;
  }
}

/** Same cap on both sides, so a mirror stays byte-identical without resends. */
function appendActivity(target: { activity: string[] }, line: string) {
  target.activity.push(line);
  if (target.activity.length > 200) target.activity.splice(0, target.activity.length - 200);
}

export const store = new Store();
