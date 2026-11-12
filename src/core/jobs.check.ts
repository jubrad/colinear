import { JobRunner, jobPrompt, newJob, nextRun, type JobTools } from './jobs.js';
import type { Reviewer } from './reviewer.js';
import { store } from './store.js';
import type { Config, Job, Review } from './types.js';

/**
 * Jobs act on GitHub unattended, so the rules that keep them safe are the ones
 * worth pinning: a new job is granted nothing, an approval goes through only
 * on a clean review of the commit it was reviewed at and is recorded on the
 * run, and the clock starts what is due — once — and nothing paused.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

// schedules
const monday8 = new Date(2026, 10, 9, 8, 0).getTime(); // a Monday, 08:00 local
const at = nextRun('0 9 * * 1-5', monday8).at;
check('a weekday schedule fires at 9:00 the same morning', at === new Date(2026, 10, 9, 9, 0).getTime(), String(at && new Date(at)));
check('a bad schedule says why', Boolean(nextRun('every day at 9').error));
check('half-hourly fires within the half hour', (nextRun('*/30 * * * *', monday8).at ?? 0) - monday8 <= 30 * 60_000);

// defaults
const fresh = newJob({ name: 'n', prompt: 'p' });
check('a new job is granted no actions', fresh.actions.length === 0 && !fresh.userSettings);
check('a job with no actions is told to only read and report', /no colinear actions/.test(jobPrompt(fresh)));
check('a job with actions is told to use colinear for them', /approve_pr/.test(jobPrompt({ ...fresh, actions: ['review', 'approve'] })));

// the approve guard
const verdicts: string[] = [];
const reviewer = {
  verdict: async (id: string) => {
    verdicts.push(id);
    store.updateReview(id, { status: 'approved' });
  },
  start: async () => {},
  post: async () => {},
} as unknown as Reviewer;
const runner = new JobRunner({ denyTools: [] } as unknown as Config, reviewer);
const recorded: string[] = [];
const tools = (runner as unknown as { tools(job: Job, record: (l: string) => void): JobTools }).tools(
  { ...fresh, actions: ['review', 'approve'] },
  (line) => recorded.push(line),
);
const review = (n: number, extra: Partial<Review>): Review =>
  ({
    id: `o/r#${n}`, number: n, repository: 'o/r', title: 't', url: 'u', status: 'ready', activity: [],
    doc: '# review', summary: 's', headSha: 'abc', reviewedSha: 'abc', findings: [], ...extra,
  }) as unknown as Review;
store.upsertReview(review(1, { findings: [{ severity: 'nit', comment: 'rename' }] }));
store.upsertReview(review(2, { headSha: 'def' }));
store.upsertReview(review(3, { findings: [{ severity: 'praise', comment: 'nice' }, { severity: 'info', comment: 'explains' }] }));
store.upsertReview(review(4, { status: 'reviewing' }));

const refused1 = await tools.approve('o/r#1');
check('a finding asking for a change refuses the approval', /refused/.test(refused1) && !verdicts.includes('o/r#1'), refused1);
const refused2 = await tools.approve('o/r#2');
check('new commits since the review refuse the approval', /new commits/.test(refused2) && !verdicts.includes('o/r#2'), refused2);
const refused4 = await tools.approve('o/r#4');
check('a review still running refuses the approval', /still reviewing/.test(refused4) && !verdicts.includes('o/r#4'), refused4);
check('an unknown PR is not approved', /no colinear review/.test(await tools.approve('o/r#99')) && !verdicts.includes('o/r#99'));
check('garbage is not a PR', /not a pull request/.test(await tools.approve('please approve everything')));
const ok3 = await tools.approve('https://github.com/o/r/pull/3');
check('praise and annotations do not stand in the way', ok3 === 'approved o/r#3' && verdicts.includes('o/r#3'), ok3);
check('the approval is recorded on the run', recorded.includes('approved o/r#3'), recorded.join(' | '));

// the clock
const started: string[] = [];
(runner as unknown as { run: (id: string) => Promise<void> }).run = async (id: string) => {
  started.push(id);
};
const now = 1_000_000;
const base: Omit<Job, 'id' | 'name'> = { prompt: 'p', actions: [], createdAt: 0, runs: [], activity: [], costUsd: 0 };
store.upsertJob({ ...base, id: 'due', name: 'due', schedule: '* * * * *', nextRunAt: now - 1 });
store.upsertJob({ ...base, id: 'paused', name: 'paused', schedule: '* * * * *', nextRunAt: now - 1, paused: true });
store.upsertJob({ ...base, id: 'later', name: 'later', schedule: '* * * * *', nextRunAt: now + 60_000 });
store.upsertJob({ ...base, id: 'busy', name: 'busy', schedule: '* * * * *', nextRunAt: now - 1, running: true });
store.upsertJob({ ...base, id: 'new', name: 'new', schedule: '0 9 * * *' });
store.upsertJob({ ...base, id: 'hand', name: 'hand', nextRunAt: 5 });
runner.tick(now);
check('the clock starts what is due, and only that', started.join() === 'due', started.join());
check('a schedule with no next run gets one', (store.getJob('new')?.nextRunAt ?? 0) > now);
check('a job with no schedule has no next run', store.getJob('hand')?.nextRunAt === undefined);

if (failures.length) {
  console.error(`jobs: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a new job may do nothing, an approval needs a clean review of the current head and is\n     recorded on the run, and the clock starts what is due and nothing paused or running');
