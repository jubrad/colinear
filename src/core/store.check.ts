/**
 * CDC check: drive the store through the mutations the dispatcher actually
 * makes, replay the deltas into a mirror, and assert the two agree. Run with
 * `npx tsx src/core/store.check.ts` — exits non-zero on divergence.
 */
import { store } from './store.js';
import type { Delta } from './delta.js';
import type { Task } from './types.js';

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
// the clear-a-field case: JSON drops undefined, so this is the one that breaks
// naive serialization
store.update('A', { status: 'done', error: undefined, endedAt: 2 });
store.update('B', { prs: [{ number: 1, title: 't', url: 'u', state: 'OPEN', isDraft: true, checksStatus: 'passing', headRefName: 'h', baseRefName: 'b' }] });
store.update('B', {
  question: { text: 'allow?', options: ['allow', 'deny'], answer: () => {} },
  status: 'needs_input',
});
for (let i = 0; i < 250; i++) store.addActivity('B', `line ${i}`);

let answered: string | undefined;
mirror.hydrate({ version: 0, tasks: [] }, (id, text) => {
  answered = `${id}:${text}`;
});
for (const delta of captured) {
  if (!mirror.apply(delta)) throw new Error(`mirror rejected delta v${delta.v} (${delta.kind})`);
}

const strip = (t: Task) => ({ ...t, question: t.question ? { text: t.question.text, options: t.question.options } : undefined });
const left = JSON.stringify(store.list().map(strip));
const right = JSON.stringify(mirror.list().map(strip));
if (left !== right) {
  console.error('DIVERGED\n source:', left, '\n mirror:', right);
  process.exit(1);
}
if (store.get('A')?.error !== undefined) throw new Error('source kept a cleared field');
if (mirror.get('A')?.error !== undefined) throw new Error('mirror kept a cleared field');
if (mirror.get('B')?.activity.length !== 200) throw new Error('mirror activity cap drifted');

mirror.get('B')?.question?.answer('allow');
if (answered !== 'B:allow') throw new Error(`answer callback not rebuilt (got ${answered})`);

// a mirror that misses a delta must ask for a snapshot rather than diverge
if (mirror.apply({ v: mirror.version + 2, kind: 'activity', id: 'A', line: 'gap' })) {
  throw new Error('mirror applied an out-of-order delta');
}
if (store.since(store.version - 5)?.length !== 5) throw new Error('since() window wrong');

// fall off the back of the log: the mirror must be told to re-snapshot
for (let i = 0; i < 1100; i++) store.addActivity('A', `overflow ${i}`);
if (store.since(0) !== null) throw new Error('since() should refuse a version off the back of the log');
if (store.since(store.version - 10)?.length !== 10) throw new Error('since() broke after truncation');

console.log(`ok — ${captured.length} deltas replayed, ${store.list().length} tasks identical`);
