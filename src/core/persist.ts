import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, log } from './log.js';
import { store } from './store.js';
import type { Task, TaskStatus } from './types.js';

const STATE_FILE = join(STATE_DIR, 'state.json');
const LIVE_STATUSES: TaskStatus[] = ['queued', 'triage', 'working', 'checks', 'needs_input'];

type PersistedTask = Omit<Task, 'question'>;

function serialize(): string {
  const tasks: PersistedTask[] = store.list().map(({ question: _q, ...rest }) => rest);
  return JSON.stringify({ version: 1, tasks }, null, 2);
}

/** Load persisted tasks; anything that was mid-flight comes back as `interrupted`. */
export function loadState(): void {
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch {
    return;
  }
  try {
    const data = JSON.parse(raw) as { tasks?: PersistedTask[] };
    for (const t of data.tasks ?? []) {
      const status: TaskStatus = LIVE_STATUSES.includes(t.status) ? 'interrupted' : t.status;
      store.upsert({ ...t, status, question: undefined });
      if (status === 'interrupted') {
        store.addActivity(t.issue.id, 'colinear restarted — press r to resume');
      }
    }
  } catch (err) {
    log(`state load failed: ${err}`);
  }
}

/** Persist on every store change, debounced; atomic rename so a crash can't torch state. */
export function startPersistence(): () => void {
  mkdirSync(STATE_DIR, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    try {
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, serialize());
      renameSync(tmp, STATE_FILE);
    } catch (err) {
      log(`state save failed: ${err}`);
    }
  };
  const unsubscribe = store.subscribe(() => {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
    flush();
  };
}
