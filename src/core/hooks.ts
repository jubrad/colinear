import { useMemo, useSyncExternalStore } from 'react';
import { store } from './store.js';
import type { ProjectPlan, Review, Task } from './types.js';

function useStoreVersion(): number {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
  );
}

/** Same identity-stability contract as useTasks (see gotchas). */
export function useReviews(): Review[] {
  const version = useStoreVersion();
  return useMemo(() => store.listReviews(), [version]);
}

export function usePlans(): ProjectPlan[] {
  const version = useStoreVersion();
  return useMemo(() => store.listPlans(), [version]);
}

export function useTasks(): Task[] {
  const version = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version,
  );
  // stable array identity per store version — effects/memos depending on the
  // task list must not re-fire on unrelated renders (a fresh array every
  // render once put BoardView's cursor-clamp effect into an infinite loop)
  return useMemo(() => store.list(), [version]);
}
