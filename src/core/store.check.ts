/**
 * CDC check: drive the store through the mutations the dispatcher actually
 * makes, replay the deltas into a mirror, and assert the two agree. Run with
 * `npx tsx src/core/store.check.ts` — exits non-zero on divergence.
 */
import { store } from './store.js';
import type { Delta } from './delta.js';
import type { Review, Task } from './types.js';

const mirror = new (Object.getPrototypeOf(store).constructor as new () => typeof store)();
const captured: Delta[] = [];
let seen = 0;
store.subscribe(() => {
  const next = store.since(seen);
  if (!next) throw new Error('log truncated mid-capture');
  captured.push(...next);
  seen = store.version;
});

const task = (id: string): Task =>
  ({
    issue: { id, identifier: id, title: `issue ${id}`, priority: 2, url: '', branchName: '', stateName: '', labels: [] },
    status: 'queued',
    activity: [],
    subtasks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    checks: [],
    prs: [],
    costUsd: 0,
  }) as Task;

store.upsert(task('A'));
store.upsert(task('B'));
store.update('A', { status: 'working', startedAt: 1, error: 'boom' });
store.addActivity('A', 'started');
store.addActivity('A', 'still going');
// operator messages queued for a task with no live session
store.update('A', { inbox: ['use the existing helper', 'rebase before pushing'] });
store.update('A', { inbox: undefined });
// the clear-a-field case: JSON drops undefined, so this is the one that breaks
// naive serialization
store.update('A', { status: 'done', error: undefined, endedAt: 2 });
store.update('B', { prs: [{ number: 1, title: 't', url: 'u', state: 'OPEN', isDraft: true, checksStatus: 'passing', headRefName: 'h', baseRefName: 'b' }] });
store.update('B', {
  // a two-question ask with option descriptions: the whole set has to survive
  // the wire, or the mirror answers a question the daemon never asked
  question: {
    kind: 'ask',
    questions: [
      {
        header: 'Auth',
        text: 'which auth for the new endpoint?',
        options: [
          { label: 'mTLS', description: 'matches the controller path' },
          { label: 'bearer', description: 'simpler, needs rotation' },
        ],
      },
      { header: 'Rollout', text: 'ship behind a flag?', options: [{ label: 'yes' }, { label: 'no' }] },
    ],
    answer: () => {},
  },
  status: 'needs_input',
});
for (let i = 0; i < 250; i++) store.addActivity('B', `line ${i}`);

// reviews ride the same CDC path as tasks
store.upsertReview({
  id: 'o/r#7', number: 7, repository: 'o/r', title: 'a PR', url: 'u', author: 'someone',
  headRefName: 'h', baseRefName: 'main', isDraft: false, additions: 10, deletions: 2,
  changedFiles: 3, updatedAt: '2026-01-01', status: 'pending', activity: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
} as Review);
store.updateReview('o/r#7', { status: 'ready', summary: 'looks fine', findings: [{ file: 'a.ts', line: 3, severity: 'nit', comment: 'naming' }] });
store.addReviewActivity('o/r#7', 'pre-review complete');
store.updateReview('o/r#7', { status: 'approved', error: undefined });

// retention drops rows; a mirror must follow rather than keep ghosts
store.upsert(task('C'));
store.update('C', { status: 'done' });
store.delete('C');
store.deleteReview('o/r#7');
store.upsertReview({
  id: 'o/r#8', number: 8, repository: 'o/r', title: 'still here', url: 'u', author: 'a',
  headRefName: 'h', baseRefName: 'main', isDraft: false, additions: 1, deletions: 1,
  changedFiles: 1, updatedAt: '2026-01-01', status: 'pending', activity: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
} as Review);

// project plans: the third CDC entity, exercised through the same lifecycle —
// upsert, patch, activity, a cleared field, and a delete
store.upsertPlan({
  id: 'proj-1', projectName: 'Cadence metrics', status: 'drafting', activity: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
});
store.updatePlan('proj-1', {
  status: 'ready',
  draft: '# plan\n\n```plan\n{"issues":[]}\n```',
  summary: 'a plan',
  issues: [{ title: 'Build the thing', description: 'd', repo: 'cadence', blockedBy: ['Other'] }],
  milestones: [{ name: 'Cutover', targetDate: '2026-09-01' }],
  docUpdatedAt: '2026-08-19T00:00:00Z',
  error: 'transient',
});
store.addPlanActivity('proj-1', 'draft ready');
store.updatePlan('proj-1', { status: 'published', publishedAt: 5, error: undefined });
store.upsertPlan({
  id: 'proj-gone', projectName: 'Dropped', status: 'drafting', activity: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
});
store.deletePlan('proj-gone');

let answered: string | undefined;
mirror.hydrate({ version: 0, tasks: [], reviews: [], plans: [] }, (id, answers) => {
  answered = `${id}:${answers.join(',')}`;
});
for (const delta of captured) {
  if (!mirror.apply(delta)) throw new Error(`mirror rejected delta v${delta.v} (${delta.kind})`);
}

const strip = (t: Task) => ({
  ...t,
  question: t.question ? { kind: t.question.kind, questions: t.question.questions } : undefined,
});
const left = JSON.stringify([store.list().map(strip), store.listReviews(), store.listPlans()]);
const right = JSON.stringify([mirror.list().map(strip), mirror.listReviews(), mirror.listPlans()]);
if (left !== right) {
  console.error('DIVERGED\n source:', left, '\n mirror:', right);
  process.exit(1);
}
if (store.get('A')?.error !== undefined) throw new Error('source kept a cleared field');
if (mirror.get('A')?.error !== undefined) throw new Error('mirror kept a cleared field');
if (mirror.get('B')?.activity.length !== 200) throw new Error('mirror activity cap drifted');
if (mirror.getPlan('proj-1')?.status !== 'published') throw new Error('mirror lost the plan status');
if (mirror.getPlan('proj-1')?.error !== undefined) throw new Error('mirror kept a cleared plan field');
if (mirror.getPlan('proj-gone')) throw new Error('mirror kept a deleted plan');

if (mirror.get('B')?.question?.questions.length !== 2) throw new Error('mirror lost a question');
if (mirror.get('B')?.question?.questions[0].options[0].description !== 'matches the controller path') {
  throw new Error('mirror lost an option description');
}
mirror.get('B')?.question?.answer(['mTLS', 'yes']);
if (answered !== 'B:mTLS,yes') throw new Error(`answer callback not rebuilt (got ${answered})`);

// a mirror that misses a delta must ask for a snapshot rather than diverge
if (mirror.apply({ v: mirror.version + 2, kind: 'activity', id: 'A', line: 'gap' })) {
  throw new Error('mirror applied an out-of-order delta');
}
if (store.since(store.version - 5)?.length !== 5) throw new Error('since() window wrong');

// fall off the back of the log: the mirror must be told to re-snapshot
for (let i = 0; i < 1100; i++) store.addActivity('A', `overflow ${i}`);
if (store.since(0) !== null) throw new Error('since() should refuse a version off the back of the log');
if (store.since(store.version - 10)?.length !== 10) throw new Error('since() broke after truncation');

if (mirror.get('C')) throw new Error('deleted task still in the mirror');
if (mirror.getReview('o/r#7')) throw new Error('deleted review still in the mirror');
if (!mirror.getReview('o/r#8')) throw new Error('later review missing from the mirror');
console.log(
  `ok — ${captured.length} deltas replayed, ${store.list().length} tasks + ${store.listReviews().length} reviews + ${store.listPlans().length} plans identical`,
);
