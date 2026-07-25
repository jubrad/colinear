import { useSyncExternalStore } from 'react';
import { store } from './store.js';
import type { Task } from './types.js';

export function useTasks(): Task[] {
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
  );
  return store.list();
}
