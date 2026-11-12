import { age, fleet, isUnread, markSeen } from './fleet.js';
import type { AgentSession } from './sessions.js';
import type { Review, Task } from './types.js';

/**
 * The agent list behind :agents and the rail. What a typecheck cannot see: an
 * agent that asked a question has *ended*, so it must come from the store and
 * not show twice; a task with an old finished session and a live one shows
 * the live one; and "new" means something happened after you last looked.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const now = 1_000_000_000;
const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const task = (identifier: string, status: string, extra: Partial<Task> = {}) =>
  ({ issue: { id: identifier, identifier, title: identifier }, status, activity: [], ...extra }) as unknown as Task;
const agent = (id: string, label: string, extra: Partial<AgentSession>) =>
  ({ id, kind: 'work', label, origin: 'dispatch', cwd: '/', startedAt: now - 1000, status: 'running', tokens, costUsd: 0, ...extra }) as AgentSession;

const question = { questions: [{ text: 'which one?', options: [] }], answer() {} } as unknown as Task['question'];
const tasks = [task('A-1', 'needs_input', { question }), task('A-2', 'working'), task('A-3', 'pr_open')];
const reviews = [{ id: 'o/r#5', repository: 'o/r', number: 5, title: 'pr', question, endedAt: now - 2000 } as unknown as Review];
const agents = [
  agent('s1', 'A-1', { status: 'done', startedAt: now - 9000, endedAt: now - 5000 }),
  agent('s2', 'A-2', { status: 'done', startedAt: now - 9000, endedAt: now - 8000, result: { ok: false, summary: 'old run' } }),
  agent('s3', 'A-2', { startedAt: now - 2000, activity: 'editing' }),
  agent('s4', 'A-3', { status: 'done', startedAt: now - 9000, endedAt: now - 3000, result: { ok: true, summary: 'PR opened' } }),
  agent('s5', 'draft', { kind: 'draft-issue', status: 'done', startedAt: now - 500, endedAt: now - 100 }),
];
const list = fleet(tasks, reviews, agents);
const shape = list.map((e) => `${e.group}:${e.label}`).join(' ');

check(
  'questions first, then working, then waiting, then done newest first',
  shape === 'needs:A-1 needs:r#5 running:A-2 waiting:A-3 finished:draft',
  shape,
);
check('a question is dated by the session that asked it', list[0].since === now - 5000);
check('a live session hides the same task\'s finished one', !list.some((e) => e.agent?.id === 's2'));
check('a review opens in :reviews by its id', list[1].open?.view === 'reviews' && list[1].open.param === 'o/r#5');
check('a draft opens nowhere', list.find((e) => e.label === 'draft')?.open === undefined);

// a stopped agent stays listed by what it is waiting on, not for ten minutes
const pr = (extra: object) => [{ number: 7, state: 'OPEN', isDraft: false, checksStatus: 'passing', ...extra }];
const parked = fleet(
  [
    task('B-1', 'error', { error: 'boom', endedAt: now - 100 }),
    task('B-2', 'pr_open', { prs: pr({ isDraft: true }) } as Partial<Task>),
    task('B-3', 'pr_open', { prs: pr({ isDraft: true, checksStatus: 'pending' }) } as Partial<Task>),
    task('B-4', 'pr_open', { prs: pr({}) } as Partial<Task>),
    task('B-5', 'pr_open', { prs: pr({ reviewDecision: 'APPROVED' }) } as Partial<Task>),
    task('B-6', 'blocked', { blockedBy: [{ id: 'x', identifier: 'B-9', kind: 'start' }] }),
    task('B-7', 'working', { awaitingStart: true }),
    task('B-8', 'done', { endedAt: now - 2 * 60 * 60 * 1000 }),
  ],
  [],
  [],
  now,
);
const groupOf = (l: string) => parked.find((e) => e.label === l)?.group;
check('a failure is yours', groupOf('B-1') === 'yours');
check('a green draft is yours to promote', groupOf('B-2') === 'yours');
check('a draft with CI running is waiting', groupOf('B-3') === 'waiting');
check('a PR in review is waiting on the reviewer', groupOf('B-4') === 'waiting');
check('an approved PR is yours to merge', groupOf('B-5') === 'yours');
check('a blocked task names its blocker', groupOf('B-6') === 'waiting' && parked.find((e) => e.label === 'B-6')!.line.includes('B-9'));
check('dispatched but not started is yours', groupOf('B-7') === 'yours');
check('done long ago drops off', groupOf('B-8') === undefined);
check('a row keys on its task, so it keeps the cursor as it changes group', parked.find((e) => e.label === 'B-1')?.key === 'task:B-1');

const seen = { 'A-3': now - 1000 };
// A-3 stopped at now - 3000: its task says so, its finished session is only the detail
const a3 = fleet([task('A-3', 'pr_open', { endedAt: now - 3000 })], [], agents).find((e) => e.label === 'A-3')!;
check('stopped after you looked is new', isUnread(a3, { 'A-3': now - 4000 }));
check('stopped before you looked is not', !isUnread(a3, seen));
check('never opened is new', isUnread(list[0], undefined));
check('a draft is never new — there is nothing to open', !isUnread(list.find((e) => e.label === 'draft')!, undefined));

check('opening a task stamps it', markSeen({}, 'task', 'A-1', now)?.['A-1'] === now);
check('the review document is the review', markSeen({}, 'reviews', 'doc:o/r#5', now)?.['o/r#5'] === now);
check('a list view stamps nothing', markSeen({}, 'board', undefined, now) === undefined);
const big = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`T-${i}`, i]));
const pruned = markSeen(big, 'task', 'NEW', now)!;
check('the map is pruned to the most recent', Object.keys(pruned).length === 200 && pruned.NEW === now && !('T-0' in pruned));

check('ages read the way a glance does', [age(now - 10_000, now), age(now - 240_000, now), age(now - 7_200_000, now)].join() === 'now,4m,2h');

if (failures.length) {
  console.error(`fleet: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — questions first and once, a stopped task stays listed by whose move it is,\n     a live session supersedes a finished one, and "new" means it happened after you last opened it');
