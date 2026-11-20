import { normalizeHideStale, reviewIsStale, taskIsStale } from './staleness.js';
import type { Review, Task } from './types.js';

/**
 * What the board, the agents table and :reviews hide for going quiet. The
 * cases a typecheck cannot see: a running agent is never quiet however long
 * it runs, opening a task is not an update, a task with nothing to date it
 * by is never hidden, and 0 switches hiding off.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const day = 86_400_000;
const now = Date.parse('2026-11-20T12:00:00Z');

const def = normalizeHideStale(undefined);
check('21 days unless told otherwise', def.board === 21 && def.tasks === 21 && def.reviews === 21, JSON.stringify(def));
const one = normalizeHideStale(7);
check('one number is every view', one.board === 7 && one.tasks === 7 && one.reviews === 7);
const per = normalizeHideStale({ reviews: 0, board: 30 });
check('per view, the rest defaulted', per.board === 30 && per.tasks === 21 && per.reviews === 0, JSON.stringify(per));
check('nonsense is the default', normalizeHideStale({ board: -3, tasks: 'x' }).board === 21);

const task = (extra: Partial<Task>): Task => ({ status: 'pr_open', issue: { identifier: 'A-1' }, ...extra }) as unknown as Task;
check('a task quiet past the threshold is stale', taskIsStale(task({ endedAt: now - 22 * day }), 21, now));
check('one inside it is not', !taskIsStale(task({ endedAt: now - 20 * day }), 21, now));
check('its work changing counts as an update', !taskIsStale(task({ endedAt: now - 40 * day, changes: { movedAt: now - day } as Task['changes'] }), 21, now));
check('a running agent is never stale', !taskIsStale(task({ status: 'working', startedAt: now - 90 * day }), 21, now));
check('a task with nothing to date it by is never stale', !taskIsStale(task({ status: 'queued' }), 21, now));
check('0 hides nothing', !taskIsStale(task({ endedAt: now - 400 * day }), 0, now));

const review = (extra: Partial<Review>): Review => ({ status: 'pending', updatedAt: new Date(now - 30 * day).toISOString(), ...extra }) as unknown as Review;
check('a PR with no update in 30 days is stale at 21', reviewIsStale(review({}), 21, now));
check('colinear reviewing it recently counts as an update', !reviewIsStale(review({ endedAt: now - day }), 21, now));
check('a review running now is never stale', !reviewIsStale(review({ status: 'reviewing' }), 21, now));

if (failures.length) {
  console.error(`staleness: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — quiet past hideStaleDays (21 by default, per view) is hidden; a running agent,\n     an undated task and a threshold of 0 never are');
