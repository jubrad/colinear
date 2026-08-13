import { encodePatch, toWire, type Change, type Delta, type Snapshot, type WireTask } from './delta.js';
import type { Task, TaskStatus } from './types.js';

type Listener = () => void;

/** how many deltas a mirror can fall behind before it needs a fresh snapshot */
const LOG_LIMIT = 1000;

class Store {
  tasks = new Map<string, Task>();
  version = 0;
  private listeners = new Set<Listener>();
  private log: Delta[] = [];
  /** set on a mirror: rebuilds the answer callback stripped for the wire */
  private onAnswer?: (id: string, text: string) => void;
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

  snapshot(): Snapshot {
    return { version: this.version, tasks: this.list().map((t) => toWire(t) as WireTask) };
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
  attach(remote: (change: Change) => void, onAnswer: (id: string, text: string) => void) {
    this.remote = remote;
    this.onAnswer = onAnswer;
  }

  /** Apply a change locally (daemon side, on behalf of a client). */
  applyChange(change: Change) {
    if (change.kind === 'upsert') this.upsert(change.task as unknown as Task);
    else if (change.kind === 'activity') this.addActivity(change.id, change.line);
    else {
      const patch = { ...change.patch } as Partial<Task>;
      for (const key of change.clear) (patch as Record<string, unknown>)[key] = undefined;
      this.update(change.id, patch);
    }
  }

  /** Mirror side: replace all state with a snapshot. */
  hydrate(snapshot: Snapshot, onAnswer?: (id: string, text: string) => void) {
    if (onAnswer) this.onAnswer = onAnswer;
    this.tasks = new Map(snapshot.tasks.map((t) => [t.issue.id, this.fromWire(t, t.issue.id)]));
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
    if (delta.kind === 'upsert') {
      this.tasks.set(delta.task.issue.id, this.fromWire(delta.task, delta.task.issue.id));
    } else {
      const task = this.tasks.get(delta.id);
      if (!task) return false;
      if (delta.kind === 'activity') {
        appendActivity(task, delta.line);
      } else {
        Object.assign(task, this.fromWire(delta.patch, delta.id));
        for (const key of delta.clear) (task as unknown as Record<string, unknown>)[key] = undefined;
      }
    }
    this.version = delta.v;
    this.notify();
    return true;
  }

  /** Re-attach the answer callback the wire format can't carry. */
  private fromWire(wire: Partial<WireTask>, id: string): Task {
    const task = wire as unknown as Task;
    if (wire.question) {
      const send = this.onAnswer;
      task.question = {
        ...wire.question,
        answer: (text: string) => send?.(id, text),
      };
    }
    return task;
  }
}

/** Same cap on both sides, so a mirror stays byte-identical without resends. */
function appendActivity(task: Task, line: string) {
  task.activity.push(line);
  if (task.activity.length > 200) task.activity.splice(0, task.activity.length - 200);
}

export const store = new Store();
