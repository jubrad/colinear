import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from './checks.js';
import { STATE_DIR } from './log.js';
import { providerFor } from './provider.js';
import { store } from './store.js';
import type { SessionResult } from './agent.js';
import type { Config, Issue, Review, Task } from './types.js';

/**
 * Demo mode: a populated board with nothing behind it.
 *
 * Everything here is fabricated in memory and in the local sqlite tracker —
 * no Claude session, no git, no `gh`, no network, nothing billed. It exists so
 * colinear can be shown, screenshotted and tested against a board that looks
 * like a working day rather than an empty one, and so UI work doesn't need a
 * Linear account or an agent budget.
 *
 * The fiction: **Cadence**, a team productivity and process-tracking app.
 */

const HOUR = 3_600_000;
const ago = (ms: number) => Date.now() - ms;

/** Issues for the tracker itself, so `:issues` has something to dispatch. */
const BACKLOG: Array<{ title: string; description: string; priority?: number }> = [
  {
    title: 'Burndown chart for the current cycle',
    description: 'Show remaining scope per day against the ideal line. Needs the cycle boundaries the digest job already computes.',
    priority: 2,
  },
  {
    title: 'Snooze a reminder until tomorrow',
    description: 'A reminder you cannot act on now should be dismissible for the day without marking the task done.',
    priority: 3,
  },
  {
    title: 'Export a cycle report as PDF',
    description: 'Same content as the weekly digest email, downloadable for people who forward it to their manager.',
  },
  {
    title: 'Track focus time per project, not just per task',
    description: 'Timers currently attach to a task; roll them up so a project page can show where the week actually went.',
    priority: 2,
  },
];

/** The board: what "mid-week, several agents deep" looks like. */
interface DemoTask {
  key: string;
  title: string;
  status: Task['status'];
  activity: string[];
  subtasks?: Array<[string, boolean]>;
  pr?: Partial<Task['prs'][number]> & { number: number };
  question?: string;
  options?: string[];
  blockedBy?: Array<{ identifier: string; kind: 'start' | 'merge' }>;
  subIssues?: Array<[string, string, boolean]>;
  minutes: number;
  tokens: [number, number];
  cost: number;
  maintenance?: Task['maintenance'];
  /** a self-review already read against the branch, for `v` → :diff */
  findings?: Task['findings'];
}

const BOARD: DemoTask[] = [
  {
    key: 'CAD-14',
    title: 'Aggregate completed work per person for the digest',
    status: 'working',
    activity: [
      '⚒ Read src/digest/aggregate.ts',
      'Grouping by assignee and cycle, reusing the cycle boundaries from metrics.ts',
      '⚒ Bash npm test -- digest',
      '3 of 4 subtasks done; writing the timezone case',
    ],
    subtasks: [
      ['read the existing digest query', true],
      ['group completions by person', true],
      ['handle people who joined mid-cycle', true],
      ['tests for week boundaries', false],
    ],
    minutes: 12,
    tokens: [48_000, 6_200],
    cost: 1.94,
  },
  {
    key: 'CAD-15',
    title: 'Weekly digest email template',
    status: 'pr_open',
    activity: ['pushed 4 commits', 'opened draft PR #218', 'checks: 1 failing (visual snapshots)'],
    pr: { number: 218, isDraft: true, checksStatus: 'failing', headRefName: 'cad-15', title: 'Weekly digest email template' },
    minutes: 41,
    tokens: [96_000, 12_400],
    cost: 3.88,
  },
  {
    key: 'CAD-9',
    title: 'Cycle time metrics on the dashboard',
    status: 'pr_open',
    activity: ['pushed 7 commits', 'opened draft PR #211', 'checks green', 'review: approved by dana'],
    pr: { number: 211, isDraft: true, checksStatus: 'passing', reviewDecision: 'APPROVED', headRefName: 'cad-9', title: 'Cycle time metrics on the dashboard' },
    minutes: 63,
    tokens: [130_000, 18_900],
    cost: 5.21,
  },
  {
    key: 'CAD-7',
    title: 'Streak calculation drifts across DST',
    status: 'pr_open',
    activity: ['pushed 2 commits', 'opened draft PR #205', 'GitHub reports the branch conflicts with main'],
    pr: { number: 205, isDraft: true, checksStatus: 'passing', mergeable: 'CONFLICTING', headRefName: 'cad-7', title: 'Fix streak drift across DST' },
    maintenance: 'rebase',
    minutes: 28,
    tokens: [61_000, 7_100],
    cost: 2.42,
    // anchored into demoDiff() so `v` opens a diff with its margin filled in —
    // an annotation beside the line it is about is the whole point of the view
    findings: [
      {
        file: 'src/digest/limiter.ts',
        line: 34,
        severity: 'consider',
        comment: 'This resets the window on read, so a caller that polls faster than the window never sees a limit.',
      },
      {
        file: 'src/digest/queue.ts',
        line: 88,
        severity: 'info',
        comment: 'Dropping here is deliberate: the digest is regenerated next window, so a skipped one is not lost work.',
      },
    ],
  },
  {
    key: 'CAD-18',
    title: 'Slack reminders for stale tasks',
    status: 'needs_input',
    activity: ['⚒ Read src/notify/slack.ts', 'The reminder cadence is not specified in the issue'],
    question: 'How often should a stale task remind its owner, and when does it stop?',
    options: ['daily until done', 'once, then weekly', 'daily for a week, then stop'],
    minutes: 6,
    tokens: [22_000, 2_800],
    cost: 0.88,
  },
  {
    key: 'CAD-21',
    title: 'Import tasks from CSV',
    status: 'blocked',
    activity: ['waiting on CAD-20 (import schema)'],
    blockedBy: [{ identifier: 'CAD-20', kind: 'start' }],
    minutes: 0,
    tokens: [0, 0],
    cost: 0,
  },
  {
    key: 'CAD-20',
    title: 'Task import schema',
    status: 'queued',
    activity: ['queued'],
    minutes: 0,
    tokens: [0, 0],
    cost: 0,
  },
  {
    key: 'CAD-12',
    title: 'Weekly review digest',
    status: 'tracking',
    activity: ['tracking 2 sub-issues'],
    subIssues: [
      ['CAD-14', 'Aggregate completed work per person', false],
      ['CAD-15', 'Weekly digest email template', false],
    ],
    minutes: 0,
    tokens: [0, 0],
    cost: 0,
  },
  {
    key: 'CAD-4',
    title: 'Pause a running timer when the laptop sleeps',
    status: 'done',
    activity: ['PR #199 merged'],
    pr: { number: 199, state: 'MERGED', isDraft: false, checksStatus: 'passing', headRefName: 'cad-4', title: 'Pause timers on sleep' },
    minutes: 34,
    tokens: [74_000, 9_300],
    cost: 2.95,
  },
];

/** PRs waiting on your review — one untouched, one already pre-reviewed. */
const REVIEWS: Array<Partial<Review> & { id: string; number: number }> = [
  {
    id: 'cadence/web#412',
    number: 412,
    repository: 'cadence/web',
    title: 'Focus-mode timer with a keyboard-only flow',
    author: 'priya',
    headRefName: 'focus-mode',
    baseRefName: 'main',
    additions: 318,
    deletions: 42,
    changedFiles: 11,
    status: 'pending',
  },
  {
    id: 'cadence/api#88',
    number: 88,
    repository: 'cadence/api',
    title: 'Rate-limit the digest job per workspace',
    author: 'dana',
    headRefName: 'digest-rate-limit',
    baseRefName: 'main',
    additions: 96,
    deletions: 14,
    changedFiles: 4,
    status: 'ready',
    summary:
      'Sound approach — the limiter is per workspace, which is the right key. Two things worth a look before this lands.',
    findings: [
      { comment: 'The limiter is keyed correctly and the backoff is sane; two points below.' },
      {
        file: 'src/digest/limiter.ts',
        line: 34,
        severity: 'blocking',
        comment: 'The window resets on read, so a workspace polling faster than the window never hits the limit.',
      },
      {
        file: 'src/digest/queue.ts',
        line: 88,
        severity: 'consider',
        comment: 'Dropping the job on limit means the digest is skipped silently — requeue with a delay instead?',
      },
      { severity: 'nit', comment: 'The 60_000 constant appears three times; name it.' },
    ],
  },
];

/**
 * The diff behind the demo's reviewed pull request.
 *
 * Without one the annotated view sits on "loading the diff…" for ever, because
 * the real one is read out of a git worktree and the demo has no repository —
 * which left the flagship view of this whole tool impossible to demo or
 * screenshot.
 *
 * The hunk headers are numbered so the seeded findings land where they belong:
 * `limiter.ts:34` is the line the window resets on, `queue.ts:88` the line that
 * drops the job. An annotation sitting beside the line it is about is the point
 * of the view, so a fabricated diff that does not line up would be worse than
 * none.
 */
export function demoDiff(): string {
  return `diff --git a/src/digest/limiter.ts b/src/digest/limiter.ts
index 5f2a1c4..9b3d7e8 100644
--- a/src/digest/limiter.ts
+++ b/src/digest/limiter.ts
@@ -26,8 +26,14 @@ export class WorkspaceLimiter {
   private readonly windows = new Map<string, Window>();
 
   /** Tokens left for this workspace in the current window. */
   remaining(workspace: string, now = Date.now()): number {
     const w = this.windows.get(workspace);
     if (!w) return this.limit;
+
+    // a new window starts the first time it is asked for after it lapses
+    if (now - w.startedAt >= WINDOW_MS) {
+      w.startedAt = now;
+      w.used = 0;
+    }
     return Math.max(0, this.limit - w.used);
   }
diff --git a/src/digest/queue.ts b/src/digest/queue.ts
index 2c81a90..7ad4f11 100644
--- a/src/digest/queue.ts
+++ b/src/digest/queue.ts
@@ -80,7 +80,11 @@ export async function enqueueDigest(job: DigestJob) {
   const limiter = limiterFor(job.workspace);
   if (limiter.remaining(job.workspace) > 0) {
     limiter.take(job.workspace);
     return queue.push(job);
   }
+
+  // over the limit: this window's digest is dropped on the floor
+  metrics.increment('digest.dropped', { workspace: job.workspace });
+  log.warn('digest skipped — workspace over its rate limit', { workspace: job.workspace });
   return undefined;
 }
diff --git a/src/digest/config.ts b/src/digest/config.ts
index 1a0b3c5..4e9f2d1 100644
--- a/src/digest/config.ts
+++ b/src/digest/config.ts
@@ -12,6 +12,8 @@ export const defaults = {
   digestHour: 9,
   timezone: 'UTC',
+  /** requests per workspace per window */
+  digestRateLimit: 20,
 };
diff --git a/test/digest/limiter.test.ts b/test/digest/limiter.test.ts
index 0000000..8c2e5b7 100644
--- a/test/digest/limiter.test.ts
+++ b/test/digest/limiter.test.ts
@@ -1,0 +1,9 @@
+import { WorkspaceLimiter } from '../../src/digest/limiter';
+
+test('a workspace over its limit is refused until the window lapses', () => {
+  const limiter = new WorkspaceLimiter(2);
+  limiter.take('acme');
+  limiter.take('acme');
+  expect(limiter.remaining('acme')).toBe(0);
+});
`;
}

/** True when this context is a fabrication rather than a workspace. */
export const isDemo = (cfg: Config): boolean => cfg.demo === true;

/** Fill the tracker so `:issues` has real, dispatchable rows. */
export async function seedDemoIssues(cfg: Config): Promise<void> {
  const provider = providerFor(cfg);
  const existing = await provider.issues('*', { includeProjects: true }).catch(() => []);
  if (existing.length) return;
  const [scope] = await provider.scopes();
  if (!scope) return;
  for (const item of BACKLOG) {
    await provider.create({ scopeId: scope.id, title: item.title, description: item.description, priority: item.priority });
  }
}

/**
 * Fill the board. Tasks are written straight into the store rather than
 * dispatched, because the point is to arrive at a mid-week board instantly.
 */
export function seedDemoBoard(cfg?: Config): void {
  if (store.list().length) return;
  // the repo the demo context actually configures — seeding a different path
  // makes triage "re-route", which drags the real worktree code into a mode
  // that has no repo to cut from
  const repo = cfg?.repos?.[0];
  for (const item of BOARD) {
    const started = ago(item.minutes * 60_000 + HOUR);
    const task: Task = {
      issue: {
        id: `demo-${item.key}`,
        identifier: item.key,
        title: item.title,
        priority: 2,
        url: '',
        branchName: item.key.toLowerCase(),
        stateName: 'In Progress',
        labels: [],
      } as Issue,
      status: item.status,
      activity: item.activity,
      subtasks: (item.subtasks ?? []).map(([text, done]) => ({ text, done })),
      tokens: { input: item.tokens[0], output: item.tokens[1], cacheRead: 0, cacheWrite: 0 },
      startedAt: item.minutes ? started : undefined,
      endedAt: item.status === 'done' ? started + item.minutes * 60_000 : undefined,
      checks: [],
      ...(item.findings ? { findings: item.findings } : {}),
      prs: item.pr
        ? [
            {
              number: item.pr.number,
              title: item.pr.title ?? item.title,
              url: `https://github.com/cadence/app/pull/${item.pr.number}`,
              state: item.pr.state ?? 'OPEN',
              isDraft: item.pr.isDraft ?? true,
              checksStatus: item.pr.checksStatus ?? 'passing',
              reviewDecision: item.pr.reviewDecision,
              mergeable: item.pr.mergeable,
              headRefName: item.pr.headRefName ?? item.key.toLowerCase(),
              baseRefName: 'main',
            },
          ]
        : [],
      costUsd: item.cost,
      repo: repo
        ? { name: repo.name, path: repo.path, defaultBranch: repo.defaultBranch, worktreeRoot: repo.worktreeRoot }
        : { name: 'cadence', path: '/demo/cadence', defaultBranch: 'main', worktreeRoot: '/demo/cadence-worktrees' },
      maintenance: item.maintenance,
      ...(item.blockedBy
        ? { blockedBy: item.blockedBy.map((b) => ({ id: `demo-${b.identifier}`, identifier: b.identifier, kind: b.kind })) }
        : {}),
      ...(item.subIssues
        ? {
            subIssues: item.subIssues.map(([identifier, title, done]) => ({
              id: `demo-${identifier}`,
              identifier,
              title,
              done,
            })),
          }
        : {}),
    };
    if (item.question) {
      task.question = {
        kind: 'ask',
        questions: [
          {
            header: 'Reminder cadence',
            text: item.question,
            options: (item.options ?? []).map((label) => ({ label })),
          },
        ],
        answer: () => {},
      };
      task.statusBeforeQuestion = 'working';
    }
    store.upsert(task);
  }

  for (const review of REVIEWS) {
    store.upsertReview({
      url: `https://github.com/${review.repository}/pull/${review.number}`,
      isDraft: false,
      updatedAt: new Date(ago(3 * HOUR)).toISOString(),
      activity: review.status === 'ready' ? ['read 4 files', 'pre-review complete: 3 findings'] : [],
      tokens: review.status === 'ready'
        ? { input: 41_000, output: 5_200, cacheRead: 0, cacheWrite: 0 }
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: review.status === 'ready' ? 1.62 : 0,
      ...review,
    } as Review);
  }
}

/**
 * A session that never happens. It emits activity at a believable pace and
 * returns a plausible result, so dispatching in demo mode moves a card across
 * the board without a token being spent.
 */
export async function demoSession(opts: {
  prompt: string;
  callbacks: { onActivity: (line: string) => void; onUsage?: (u: { input: number; output: number; cacheRead: number; cacheWrite: number }) => void };
  outputSchema?: Record<string, unknown>;
}): Promise<SessionResult> {
  const triage = Boolean(opts.outputSchema);
  const lines = triage
    ? ['⚒ Glob src/**/*.ts', 'Reading the surrounding code to scope this', 'verdict: do — small, testable in place']
    : [
        '⚒ Read src/cadence/index.ts',
        'Writing the change alongside the existing pattern',
        '⚒ Bash npm test',
        'tests pass; pushing the branch',
      ];
  for (const line of lines) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    opts.callbacks.onActivity(line);
    opts.callbacks.onUsage?.({ input: 4_100, output: 520, cacheRead: 0, cacheWrite: 0 });
  }
  return {
    text: triage ? 'triaged' : 'done (demo)',
    structured: triage
      ? { verdict: 'do', reason: 'Self-contained; the surrounding code already has the pattern.', repo: 'cadence', verification: 'local-light' }
      : undefined,
    costUsd: 0,
    isError: false,
    errors: [],
    assistantTurns: lines.length,
  };
}

/** A workspace that isn't one: demo mode never runs git. */
export function demoWorktree(issue: Issue): { worktree: string; branch: string } {
  const worktree = join(STATE_DIR, 'demo-worktrees', issue.identifier);
  mkdirSync(worktree, { recursive: true });
  return { worktree, branch: issue.identifier.toLowerCase() };
}

let demoPr = 230;

/**
 * The PR a scripted session would have opened. Demo mode disables PR polling
 * (it would ask `gh` about branches that don't exist), so the card needs one
 * from somewhere or the work would just vanish into `done`.
 */
export function demoPullRequest(issue: Issue): Task['prs'][number] {
  const number = demoPr++;
  return {
    number,
    title: issue.title,
    url: `https://github.com/cadence/app/pull/${number}`,
    state: 'OPEN',
    isDraft: true,
    checksStatus: 'pending',
    headRefName: issue.identifier.toLowerCase(),
    baseRefName: 'main',
  };
}

/** Checks in demo mode: plausible, instant, and nothing executed. */
export function demoChecks(): ReturnType<typeof runChecks> {
  return Promise.resolve([
    { name: 'lint', ok: true, output: 'demo: not run' },
    { name: 'test', ok: true, output: 'demo: not run' },
  ]);
}
