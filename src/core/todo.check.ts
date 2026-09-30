/**
 * :todo's scoring, held to its word with a fixed clock: the review SLA counts
 * working hours, a late review outranks a far deadline but not a waiting
 * agent, an issue under a live task is listed once or not at all, and the
 * agent's answer can reorder the list but never add to it.
 *
 * Run with `npx tsx src/core/todo.check.ts` — exits non-zero on the first
 * broken promise. `bin/check` runs it.
 */
import {
  DEFAULT_TODO_POLICY,
  applyRanking,
  buildCandidates,
  daysUntil,
  handledReason,
  rankPrompt,
  workingHoursBetween,
} from './todo.js';
import type { Issue, Project, Review, Task, TodoConfig } from './types.js';

let failed = 0;
function expect(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return;
  failed++;
  console.error(`FAIL ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const cfg: TodoConfig = { enabled: true, reviewSlaHours: 24, staleDays: 14, horizonDays: 21, refreshMinutes: 0, maxCandidates: 60 };
// Wednesday 30 September 2026, 10:00 local
const NOW = new Date(2026, 8, 30, 10, 0).getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ── the clock ──
{
  const friday5pm = new Date(2026, 8, 25, 17, 0).getTime();
  const monday9am = new Date(2026, 8, 28, 9, 0).getTime();
  const h = workingHoursBetween(friday5pm, monday9am);
  expect('a weekend does not age a review (Fri 17:00 → Mon 09:00 is 16 working hours)', Math.abs(h - 16) < 1e-9, h);
  expect('an ISO day is local midnight: today is 0 days away', daysUntil(iso(2026, 9, 30), NOW) === 0);
  expect('tomorrow is 1', daysUntil(iso(2026, 10, 1), NOW) === 1);
  expect('yesterday is -1', daysUntil(iso(2026, 9, 29), NOW) === -1);
}

const review = (n: number, patch: Partial<Review>): Review => ({
  id: `o/r#${n}`, number: n, repository: 'o/r', title: `PR ${n}`, url: `https://example.invalid/${n}`,
  author: 'someone', headRefName: 'h', baseRefName: 'main', isDraft: false,
  additions: 10, deletions: 2, changedFiles: 1, updatedAt: hoursAgo(1), status: 'pending',
  activity: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0,
  requested: true, requestedVia: 'you', ...patch,
});

const issue = (id: string, patch: Partial<Issue>): Issue => ({
  id, identifier: id, title: `issue ${id}`, priority: 3, url: `https://example.invalid/${id}`,
  branchName: id.toLowerCase(), stateName: 'Todo', stateType: 'unstarted', labels: [], ...patch,
});

const task = (i: Issue, patch: Partial<Task>): Task => ({
  issue: i, status: 'working', activity: [], subtasks: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, checks: [], prs: [], costUsd: 0, ...patch,
});

// ── reviews ──
{
  // requested Monday 9:00 — Mon 15h + Tue 24h + Wed 10h = 49 working hours
  const late = review(1, { requestedAt: new Date(2026, 8, 28, 9, 0).toISOString() });
  const fresh = review(2, { requestedAt: hoursAgo(2) });
  const draft = review(3, { requestedAt: hoursAgo(200), isDraft: true });
  const posted = review(4, { requestedAt: hoursAgo(50), requested: false, status: 'commented' });
  const untouched = review(5, { requestedAt: hoursAgo(24 * 30), updatedAt: hoursAgo(24 * 20) });
  const items = buildCandidates({ tasks: [], reviews: [late, fresh, draft, posted, untouched], issues: [], projects: [], now: NOW, cfg });
  const by = (n: number) => items.find((i) => i.key === `review:o/r#${n}`);
  expect('a review past its SLA is "now"', by(1)?.urgency === 'now', by(1));
  expect('a fresh review is "today"', by(2)?.urgency === 'today', by(2));
  expect('the longer it waits, the higher it goes', (by(1)?.score ?? 0) > (by(2)?.score ?? 0));
  expect('a draft is stale and goes to the bottom', by(3)?.facts.stale === true && by(3)?.urgency === 'later');
  expect('an untouched PR is stale too', by(5)?.facts.stale === true);
  expect('a stale review ranks under a fresh one', (by(3)?.score ?? 0) < (by(2)?.score ?? 0));
  expect('a review you have posted is not asked of you', !by(4));
  expect('working hours, not wall-clock', Math.abs((by(1)?.facts.waitingHours ?? 0) - 49) < 0.2, by(1)?.facts);
  const team = buildCandidates({
    tasks: [], reviews: [review(6, { requestedAt: hoursAgo(2), requestedVia: 'team' })], issues: [], projects: [], now: NOW, cfg,
  })[0];
  expect('a team request is discounted', (team?.score ?? 0) < (by(2)?.score ?? 0), team);
}

// ── the balance ──
{
  const lateReview = review(1, { requestedAt: new Date(2026, 8, 28, 9, 0).toISOString() });
  const farIssue = issue('FAR', { priority: 3, dueDate: iso(2026, 10, 10) });
  const asking = issue('ASK', { priority: 3 });
  const askingTask = task(asking, {
    status: 'needs_input',
    question: { kind: 'ask', questions: [{ text: 'which table?', options: [] }], answer: () => {} },
  });
  const urgentOverdue = issue('URG', { priority: 1, dueDate: iso(2026, 9, 28), stateType: 'started', stateName: 'In Progress' });
  const items = buildCandidates({
    tasks: [askingTask], reviews: [lateReview], issues: [farIssue, asking, urgentOverdue], projects: [], now: NOW, cfg,
  });
  const rank = (key: string) => items.findIndex((i) => i.key === key);
  expect('a late review outranks a medium issue due in 10 days', rank('review:o/r#1') < rank('issue:FAR'), items.map((i) => i.key));
  expect('an agent stopped on a question outranks a late review', rank('task:ASK') < rank('review:o/r#1'), items.map((i) => i.key));
  expect('an urgent, overdue, started issue outranks a late review', rank('issue:URG') < rank('review:o/r#1'), items.map((i) => [i.key, i.score]));
  expect('an issue with a live task is listed once, as the task', rank('issue:ASK') === -1);
}

// ── the ceiling ──
{
  // weeks late, both: the older still goes first rather than tying
  const weeks = review(7, { requestedAt: hoursAgo(24 * 60) });
  const week = review(8, { requestedAt: hoursAgo(24 * 8) });
  const plain = issue('PLAIN', { priority: 0 });
  const stuck = task(plain, {
    status: 'needs_input',
    question: { kind: 'ask', questions: [{ text: 'q', options: [] }], answer: () => {} },
  });
  const items = buildCandidates({ tasks: [stuck], reviews: [weeks, week], issues: [plain], projects: [], now: NOW, cfg });
  const at = (key: string) => items.findIndex((i) => i.key === key);
  expect('the oldest request does not tie with last week\'s', at('review:o/r#7') < at('review:o/r#8'), items.map((i) => [i.key, i.score]));
  expect('a question on an unprioritized issue still outranks the oldest review', at('task:PLAIN') < at('review:o/r#7'), items.map((i) => [i.key, i.score]));
}

// ── tasks and issues are never the same thing twice ──
{
  const working = issue('W', { priority: 1 });
  const landed = issue('L', { priority: 2 });
  const items = buildCandidates({
    tasks: [task(working, { status: 'working' }), task(landed, { status: 'done' })],
    reviews: [], issues: [working, landed], projects: [], now: NOW, cfg,
  });
  expect('an issue an agent is working is not on the list at all', !items.some((i) => i.key.endsWith(':W')), items.map((i) => i.key));
  expect('an issue whose task is over is back to being an issue', items.some((i) => i.key === 'issue:L'));
}

// ── milestones and projects ──
{
  const due = iso(2026, 10, 3);
  const a = issue('M1', { projectId: 'p1', projectName: 'Beta', milestoneName: 'GA', milestoneTargetDate: due });
  const b = issue('M2', { projectId: 'p1', projectName: 'Beta', milestoneName: 'GA', milestoneTargetDate: due });
  const lone = issue('M3', { projectId: 'p1', projectName: 'Beta', milestoneName: 'Later', milestoneTargetDate: due });
  const project: Project = {
    id: 'p1', name: 'Beta', state: 'started', progress: 0.4, targetDate: iso(2026, 10, 6), url: 'u', scopes: [], lead: 'Me', priority: 2,
  };
  const other: Project = { ...project, id: 'p2', name: 'Theirs', lead: 'Someone Else' };
  const items = buildCandidates({ tasks: [], reviews: [], issues: [a, b, lone], projects: [project, other], viewerName: 'me', now: NOW, cfg });
  const ms = items.find((i) => i.key === 'milestone:p1:GA');
  expect('two issues racing one milestone make a milestone entry', ms?.facts.openIssues === 2, ms);
  expect('one issue in a milestone carries its own date instead', !items.some((i) => i.key === 'milestone:p1:Later'));
  expect('a milestone date reaches the issue', items.find((i) => i.key === 'issue:M1')?.facts.dueFrom === 'milestone');
  expect('a project you lead with a close date is listed', items.some((i) => i.key === 'project:p1'));
  expect("someone else's project is not", !items.some((i) => i.key === 'project:p2'));
}

// ── the agent orders, it cannot add ──
{
  const candidates = buildCandidates({
    tasks: [], reviews: [review(1, { requestedAt: hoursAgo(30) }), review(2, { requestedAt: hoursAgo(2) })],
    issues: [], projects: [], now: NOW, cfg,
  });
  const { items, unknown } = applyRanking(candidates, {
    summary: 'x',
    items: [
      { key: 'review:o/r#2', action: 'Quick one', why: 'Tiny.', urgency: 'now' },
      { key: 'review:o/r#99', action: 'Invented', why: 'No.', urgency: 'now' },
      { key: 'review:o/r#2', action: 'Again', why: 'Dup.', urgency: 'later' },
      { key: 'review:o/r#1', action: '', why: '', urgency: 'someday' },
    ],
  });
  expect('the agent chooses the order', items.map((i) => i.key).join() === 'review:o/r#2,review:o/r#1', items.map((i) => i.key));
  expect('an invented key is dropped and counted', unknown === 1);
  expect('a duplicate keeps its first place and wording', items[0].action === 'Quick one');
  expect('the entry itself comes from colinear', items[0].url === 'https://example.invalid/2' && items[0].facts.slaHours === 24);
  expect('empty wording falls back to colinear\'s', items[1].action === candidates.find((c) => c.key === 'review:o/r#1')?.action);
  expect('an unknown urgency falls back', items[1].urgency === candidates.find((c) => c.key === 'review:o/r#1')?.urgency);
}

// ── ticking things off ──
{
  const r = review(1, { requestedAt: hoursAgo(30) });
  const asked = issue('Q', {});
  const t = task(asked, { status: 'needs_input', question: { kind: 'ask', questions: [{ text: 'q', options: [] }], answer: () => {} } });
  const items = buildCandidates({ tasks: [t], reviews: [r], issues: [], projects: [], now: NOW, cfg });
  const reviews = new Map([[r.id, r]]);
  const tasks = new Map([[asked.id, t]]);
  const live = { review: (id: string) => reviews.get(id), task: (id: string) => tasks.get(id), tasks: () => [...tasks.values()] };
  const reviewItem = items.find((i) => i.kind === 'review')!;
  const taskItem = items.find((i) => i.kind === 'task')!;
  expect('an untouched review still wants you', handledReason(reviewItem, live, cfg, NOW) === undefined);
  reviews.set(r.id, { ...r, requested: false, status: 'approved', posted: { at: NOW, event: 'APPROVE', url: '', comments: 0 } });
  expect('a posted review reads as reviewed', handledReason(reviewItem, live, cfg, NOW) === 'reviewed');
  expect('a waiting question still wants you', handledReason(taskItem, live, cfg, NOW) === undefined);
  tasks.set(asked.id, { ...t, status: 'working', question: undefined });
  expect('an answered question hands it back to the agent', handledReason(taskItem, live, cfg, NOW) === 'agent on it');
}

// ── the prompt ──
{
  const candidates = buildCandidates({ tasks: [], reviews: [review(1, { requestedAt: hoursAgo(3) })], issues: [], projects: [], now: NOW, cfg });
  const standard = rankPrompt(cfg, candidates, NOW, 'Me');
  expect('the default policy is used when none is configured', standard.includes(DEFAULT_TODO_POLICY));
  expect('every candidate key is in the prompt', candidates.every((c) => standard.includes(`"key":"${c.key}"`)));
  const custom = rankPrompt({ ...cfg, prompt: 'Reviews always first.', guidance: 'Mornings are for deep work.' }, candidates, NOW);
  expect('a configured policy replaces the default', custom.includes('Reviews always first.') && !custom.includes(DEFAULT_TODO_POLICY));
  expect('guidance is added after it', custom.indexOf('Mornings are for deep work.') > custom.indexOf('Reviews always first.'));
  expect('the answer format survives a replaced policy', custom.includes('key: exactly as given'));
}

if (failed) {
  console.error(`${failed} todo check${failed === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('ok — todo scoring, dedupe, ranking and ticking-off hold');
