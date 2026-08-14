import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, log } from './log.js';
import { restorePlanners, serializePlanners, type PlannerSnapshot } from './planner.js';
import { store } from './store.js';
import type { Config, Review, Task, TaskStatus } from './types.js';

const STATE_FILE = join(STATE_DIR, 'state.json');
const LIVE_STATUSES: TaskStatus[] = ['queued', 'triage', 'working', 'checks', 'needs_input'];

type PersistedTask = Omit<Task, 'question'>;
type PersistedReview = Omit<Review, 'question'>;

export interface UiState {
  /** last picker team: 'mine', '*', or a team key */
  team?: string;
}

interface PersistedState {
  version: number;
  tasks?: PersistedTask[];
  reviews?: PersistedReview[];
  planners?: PlannerSnapshot[];
  ui?: UiState;
}

let uiState: UiState = {};

export function getUiState(): UiState {
  return uiState;
}

export function setUiState(patch: Partial<UiState>): void {
  Object.assign(uiState, patch);
}

function serialize(): string {
  const tasks: PersistedTask[] = store.list().map(({ question: _q, ...rest }) => rest);
  const reviews: PersistedReview[] = store.listReviews().map(({ question: _q, ...rest }) => rest);
  const state: PersistedState = { version: 3, tasks, reviews, planners: serializePlanners(), ui: uiState };
  return JSON.stringify(state, null, 2);
}

/** Load persisted state; anything that was mid-flight comes back as `interrupted`. */
export function loadState(cfg: Config): void {
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch {
    return;
  }
  try {
    const data = JSON.parse(raw) as PersistedState;
    for (const t of data.tasks ?? []) {
      const status: TaskStatus = LIVE_STATUSES.includes(t.status) ? 'interrupted' : t.status;
      // pre-cache-split states folded cache traffic into `input`. That total
      // is ~95% cache reads in practice, so reclassify it wholesale — a small
      // undercount of real input beats a headline inflated 20x
      const tokens =
        t.tokens.cacheRead === undefined
          ? { input: 0, output: t.tokens.output, cacheRead: t.tokens.input, cacheWrite: 0 }
          : t.tokens;
      store.upsert({ ...t, status, tokens, question: undefined });
      if (status === 'interrupted') {
        store.addActivity(t.issue.id, 'colinear restarted — press r to resume');
      }
    }
    for (const r of data.reviews ?? []) {
      // a review that was mid-flight comes back idle; findings survive
      const status =
        r.status === 'reviewing' || r.status === 'posting' || r.status === 'queued'
          ? r.summary
            ? 'ready'
            : 'pending'
          : // 'posted' was colinear's word before GitHub's own (COMMENTED) won
            ((r.status as string) === 'posted' ? 'commented' : r.status);
      store.upsertReview({ ...r, status, question: undefined });
    }
    restorePlanners(cfg, data.planners ?? []);
    uiState = data.ui ?? {};
  } catch (err) {
    log(`state load failed: ${err}`);
  }
}

/**
 * Persist on store changes (debounced), on a slow heartbeat (catches planner
 * chats and UI prefs, which live outside the store), and once on exit.
 * Atomic rename so a crash can't torch state.
 */
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
  const heartbeat = setInterval(flush, 10_000);
  return () => {
    clearTimeout(timer);
    clearInterval(heartbeat);
    unsubscribe();
    flush();
  };
}
