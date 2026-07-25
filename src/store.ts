import type { Task, TaskStatus } from './types.js';

type Listener = () => void;

class Store {
  tasks = new Map<string, Task>();
  version = 0;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  upsert(task: Task) {
    this.tasks.set(task.issue.id, task);
    this.emit();
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, patch: Partial<Task>) {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, patch);
    this.emit();
  }

  setStatus(id: string, status: TaskStatus) {
    this.update(id, { status });
  }

  addActivity(id: string, line: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.activity.push(line);
    if (task.activity.length > 200) task.activity.splice(0, task.activity.length - 200);
    this.emit();
  }

  list(): Task[] {
    return [...this.tasks.values()];
  }
}

export const store = new Store();
