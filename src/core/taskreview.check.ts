import { store } from './store.js';
import { actionable, sweepTaskReviews } from './taskreview.js';
import type { Config, Review, Task } from './types.js';

/**
 * The review loop on a task's own PR, stepped by hand: review, hand back,
 * wait for the push, review again, stop at the cap. What a typecheck cannot
 * see: nothing is handed to a task that is busy, the same findings are never
 * handed twice, a failed round is not retried on its own, and switching it
 * off stops everything.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const cfg = { taskReviews: { auto: true, maxRounds: 2 } } as unknown as Config;
const started: string[] = [];
const handed: string[] = [];
let accept = true;
const deps = {
  startReview: (id: string) => started.push(id),
  revise: (taskId: string, text: string) => (accept ? (handed.push(`${taskId}:${text}`), true) : false),
};

store.upsert({ issue: { id: 'T1', identifier: 'CLO-1', title: 't' }, status: 'pr_open', activity: [], subtasks: [], prs: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Task);
store.upsertReview({
  id: 'o/r#1', number: 1, repository: 'o/r', title: 't', status: 'pending', activity: [], task: 'CLO-1',
  headSha: 'aaa', repo: { name: 'r', path: '/r', worktreeRoot: '/w' }, findings: [], updatedAt: '2026-01-01T00:00:00Z',
} as unknown as Review);
const r = () => store.getReview('o/r#1')!;

// round 1 starts on its own
sweepTaskReviews(cfg, deps);
check('a new task PR is reviewed', started.length === 1 && r().autoRounds === 1);
sweepTaskReviews(cfg, deps);
check('and not twice for the same head', started.length === 1);

// it finishes with findings; the task is busy, so they wait
store.updateReview('o/r#1', { status: 'ready', reviewedSha: 'aaa', findings: [
  { file: 'a.ts', line: 3, severity: 'blocking', comment: 'this drops the error' },
  { severity: 'info', comment: 'explains the change' },
  { severity: 'praise', comment: 'nice' },
] } as Partial<Review>);
store.update('T1', { maintenance: 'fixci' } as Partial<Task>);
sweepTaskReviews(cfg, deps);
check('a busy task is not handed anything', handed.length === 0);
store.update('T1', { maintenance: undefined } as Partial<Task>);
sweepTaskReviews(cfg, deps);
check('an idle one gets the findings', handed.length === 1 && /drops the error/.test(handed[0]), handed.join(' | '));
check('only what it should act on — no annotations, no praise', !/explains the change|nice/.test(handed[0]));
check('it is told another round follows', /reviews the PR again/.test(handed[0]));
sweepTaskReviews(cfg, deps);
check('the same findings are handed once', handed.length === 1);
check('no review starts before the agent pushes', started.length === 1);

// the agent pushes; round 2
store.updateReview('o/r#1', { headSha: 'bbb' });
sweepTaskReviews(cfg, deps);
check('a push after a hand-back is reviewed again', started.length === 2 && r().autoRounds === 2);
store.updateReview('o/r#1', { status: 'ready', reviewedSha: 'bbb', findings: [{ file: 'a.ts', line: 9, severity: 'nit', comment: 'rename' }] } as Partial<Review>);
sweepTaskReviews(cfg, deps);
check('round 2 is handed back as the last', handed.length === 2 && /last automatic round/.test(handed[1]), handed[1]);
store.updateReview('o/r#1', { headSha: 'ccc' });
sweepTaskReviews(cfg, deps);
check('the cap stops it', started.length === 2);

// a clean review hands nothing and says so
store.updateReview('o/r#1', { autoRounds: 1, handedSha: undefined, status: 'ready', reviewedSha: 'ccc', findings: [{ severity: 'praise', comment: 'good' }] } as Partial<Review>);
sweepTaskReviews(cfg, deps);
check('nothing actionable: nothing handed, and the review records it', handed.length === 2 && r().handedSha === 'ccc');

// a failed round is the operator's
store.updateReview('o/r#1', { autoRounds: 1, handedSha: undefined, status: 'error', reviewedSha: undefined, headSha: 'ddd' } as Partial<Review>);
sweepTaskReviews(cfg, deps);
check('a round that failed is not retried on its own', started.length === 2);

// off is off
store.updateReview('o/r#1', { autoRounds: 0, status: 'pending', handedSha: undefined } as Partial<Review>);
sweepTaskReviews({ taskReviews: { auto: false, maxRounds: 2 } } as unknown as Config, deps);
check('taskReviews off starts nothing', started.length === 2);

check('actionable drops annotations, praise and empty comments', actionable([{ severity: 'info', comment: 'x' }, { severity: 'praise', comment: 'y' }, { severity: 'consider', comment: ' ' }, { severity: 'consider', comment: 'z' }]).length === 1);

if (failures.length) {
  console.error(`task review: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a task PR is reviewed, its findings handed to an idle agent once, reviewed again\n     after the push, and stopped at the cap; a failed round and taskReviews: false start nothing');
