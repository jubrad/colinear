import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import { runtimeFor } from './agent.js';
import { isDemo } from './demo.js';
import { STATE_DIR, log } from './log.js';
import { modelsFor } from './models.js';
import type { Reviewer } from './reviewer.js';
import { adoptReview, parsePrSpec, reviewId } from './reviews.js';
import { store } from './store.js';
import type { Config, Job, JobAction, JobRun, Review } from './types.js';

/**
 * Jobs: work asked of colinear directly, once or on a schedule — "review and
 * approve the dependabot PRs", "summarise my week on GitHub". No tracker issue
 * and no PR behind it, so it is neither a task nor a review; its output is a
 * report you read in `:jobs`.
 *
 * What a job may do is its security profile, set per job: the colinear
 * actions it may call (each one a tool that only exists in its session when
 * granted), its permission mode and deny list on top of the config's, and
 * whether your own user-level settings — your MCP servers — come with it.
 * Actions that reach GitHub go through colinear's own paths: an approval is
 * the same deterministic `gh api` post `a` makes in `:reviews`, never the
 * agent's own `gh` call, and colinear refuses it while the review has findings.
 */

/** A job's colinear actions, as its session sees them. */
export interface JobTools {
  actions: JobAction[];
  review(pr: string, instructions?: string): Promise<string>;
  approve(pr: string): Promise<string>;
  comment(pr: string): Promise<string>;
}

/** How many runs a job keeps: enough to see a pattern, not a log file. */
const KEEP_RUNS = 20;
/** The clock's tick. Cron's finest grain is a minute; half that keeps a run on its minute. */
const TICK_MS = 30_000;

/** Findings that ask for a change. Praise and annotations don't stand in the way of an approval. */
const ASKS_FOR_CHANGE = new Set(['blocking', 'consider', 'comment', 'nit']);

/** The next time `schedule` fires after `after`, or why it can't. */
export function nextRun(schedule: string, after = Date.now()): { at?: number; error?: string } {
  try {
    const next = new Cron(schedule.trim(), { paused: true }).nextRun(new Date(after));
    return next ? { at: next.getTime() } : { error: 'never fires' };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).replace(/^CronPattern: /, '') };
  }
}

/** A fresh job with nothing granted: the safe default is a job that can only read and report. */
export function newJob(fields: Partial<Job> & { name: string; prompt: string }): Job {
  return {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    actions: [],
    createdAt: Date.now(),
    runs: [],
    activity: [],
    costUsd: 0,
    ...fields,
  };
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'one line on how the run went' },
    report: { type: 'string', description: 'the full result, in markdown' },
  },
  required: ['summary', 'report'],
  additionalProperties: false,
};

export function jobPrompt(job: Job): string {
  const granted = job.actions.length
    ? `You can act through colinear with these tools, and only these: ${job.actions
        .map((a) => ({ review: 'review_pr', approve: 'approve_pr', comment: 'comment_pr' })[a])
        .join(', ')}. Use them rather than doing the same thing yourself with gh — colinear records what they did and posts deterministically.`
    : 'You have no colinear actions: read, gather and report. Do not post, comment, approve, push or file anything.';
  return `You are running a job for the operator of colinear, an agent orchestrator. Nobody is watching this session live; what you return is read later.

The job, in the operator's words:

${job.prompt}

${granted}

Work it through, then answer with:
- summary: one line on how it went ("approved 3 of 5 dependabot PRs; 2 had findings")
- report: the result in markdown, written for the operator to read cold — lists over prose, links where you have them. Say plainly what you did and did not do, and why.

Do not ask questions — no one is there to answer. Where a judgement is needed, make the conservative call and say so in the report.`;
}

export class JobRunner {
  private aborts = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;

  constructor(
    private cfg: Config,
    private reviewer: Reviewer,
  ) {}

  onToast?: (text: string, kind: 'info' | 'ok' | 'err') => void;

  startClock() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  shutdown() {
    clearInterval(this.timer);
    for (const controller of this.aborts.values()) controller.abort();
  }

  /** Start what is due, and give a schedule with no next run one. */
  tick(now = Date.now()) {
    for (const job of store.listJobs()) {
      if (!job.schedule) {
        if (job.nextRunAt) store.updateJob(job.id, { nextRunAt: undefined });
        continue;
      }
      if (!job.nextRunAt) {
        const { at } = nextRun(job.schedule, now);
        if (at) store.updateJob(job.id, { nextRunAt: at });
        continue;
      }
      // a run missed while the daemon was down happens once, now, not once per miss
      if (job.nextRunAt <= now && !job.paused && !job.running) void this.run(job.id, 'schedule');
    }
  }

  cancel(id: string): boolean {
    const controller = this.aborts.get(id);
    if (!controller) return false;
    controller.abort();
    store.addJobActivity(id, 'cancelled by you');
    return true;
  }

  async run(id: string, trigger: JobRun['trigger']): Promise<void> {
    const job = store.getJob(id);
    if (!job || job.running || this.aborts.has(id)) return;
    if (isDemo(this.cfg)) {
      store.addJobActivity(id, 'demo mode: jobs run nothing here');
      this.onToast?.('demo mode — jobs are not wired to anything', 'info');
      return;
    }
    const runtime = runtimeFor(this.cfg, 'job', job.model);
    const startedAt = Date.now();
    const run: JobRun = { startedAt, status: 'running', trigger, actions: [] };
    const patchRun = (patch: Partial<JobRun>) => {
      Object.assign(run, patch);
      const current = store.getJob(id);
      if (!current) return;
      const runs = current.runs.filter((r) => r.startedAt !== startedAt);
      store.updateJob(id, { runs: [...runs, { ...run, actions: [...run.actions] }].slice(-KEEP_RUNS) });
    };
    const nextAt = job.schedule ? nextRun(job.schedule, startedAt).at : undefined;
    store.updateJob(id, { running: true, nextRunAt: nextAt });
    patchRun({});
    store.addJobActivity(id, `${trigger === 'schedule' ? 'scheduled run' : 'run'} started`);

    if (job.actions.length && !runtime.backend.capabilities.colinearTools) {
      patchRun({ status: 'error', endedAt: Date.now(), error: `${runtime.backend.name} cannot be given colinear's tools — pick a Claude model for this job` });
      store.updateJob(id, { running: undefined });
      return;
    }

    const controller = new AbortController();
    this.aborts.set(id, controller);
    const cwd = join(STATE_DIR, 'jobs', id);
    mkdirSync(cwd, { recursive: true });
    const record = (line: string) => {
      run.actions.push(line);
      patchRun({});
      store.addJobActivity(id, line);
    };

    try {
      const result = await runtime.backend.runSession({
        prompt: jobPrompt(job),
        cwd,
        permissions: {
          mode: job.permissionMode ?? this.cfg.agentPermissionMode,
          deny: [...this.cfg.denyTools, ...(job.deny ?? [])],
        },
        agent: { kind: 'job', label: job.name, origin: trigger === 'schedule' ? `scheduled: ${job.schedule}` : 'you pressed r in :jobs' },
        callbacks: {
          onActivity: (line) => store.addJobActivity(id, line),
          onSessionId: (sessionId) => patchRun({ sessionId }),
          // nobody is there to answer; the prompt says so, this makes it true
          onQuestion: (q) => q.answer(q.questions.map(() => 'No one is available to answer — make the conservative call and note it in the report.')),
        },
        outputSchema: REPORT_SCHEMA,
        jobTools: job.actions.length ? this.tools(job, record) : undefined,
        userSettings: job.userSettings,
        ...modelsFor(this.cfg, 'job', job.model),
        maxTurns: 200,
        abortController: controller,
      });
      if (result.spend) {
        const current = store.getJob(id);
        store.updateJob(id, {
          spend: [...(current?.spend ?? []), result.spend].slice(-50),
          costUsd: (current?.costUsd ?? 0) + (result.spend.costUsd ?? 0),
        });
      }
      if (controller.signal.aborted) {
        patchRun({ status: 'cancelled', endedAt: Date.now(), costUsd: result.costUsd });
        return;
      }
      const answer = result.structured as { summary?: string; report?: string } | undefined;
      if (result.isError || !answer?.report) {
        const why = result.errors.join('; ') || 'no report in the shape asked for';
        patchRun({ status: 'error', endedAt: Date.now(), error: why.slice(0, 300), report: result.text || undefined, costUsd: result.costUsd });
        this.onToast?.(`job ${job.name} failed: ${why.slice(0, 100)}`, 'err');
        return;
      }
      patchRun({ status: 'ok', endedAt: Date.now(), summary: answer.summary?.trim(), report: answer.report, costUsd: result.costUsd });
      store.addJobActivity(id, `finished: ${answer.summary?.trim() ?? 'done'}`);
      this.onToast?.(`job ${job.name}: ${answer.summary?.trim() ?? 'done'}`, 'ok');
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 300);
      patchRun({ status: controller.signal.aborted ? 'cancelled' : 'error', endedAt: Date.now(), error: message });
      log(`job ${id}: ${message}`);
    } finally {
      this.aborts.delete(id);
      store.updateJob(id, { running: undefined });
    }
  }

  /** The actions a job was granted, bound to it so every one is recorded on its run. */
  private tools(job: Job, record: (line: string) => void): JobTools {
    const resolve = (spec: string): { id: string; label: string } | string => {
      const pr = parsePrSpec(spec);
      if (!pr) return `${spec} is not a pull request — use owner/repo#123 or its URL`;
      return { id: reviewId(pr.repository, pr.number), label: `${pr.repository}#${pr.number}` };
    };
    return {
      actions: job.actions,
      review: async (spec, instructions) => {
        const target = resolve(spec);
        if (typeof target === 'string') return target;
        let review: Review;
        try {
          review = await adoptReview(this.cfg, spec);
        } catch (err) {
          return String((err as Error)?.message ?? err);
        }
        const settled = ['ready', 'commented', 'approved', 'changes_requested'].includes(review.status);
        if (settled && review.reviewedSha && review.reviewedSha === review.headSha) {
          return `${target.label} was already reviewed at its current head — not re-reviewing.\n\n${describe(review)}`;
        }
        record(`reviewing ${target.label}`);
        await this.reviewer.start(target.id, instructions ? { instructions } : undefined);
        const done = store.getReview(target.id);
        if (!done) return `${target.label}: the review vanished`;
        if (done.status === 'error') return `${target.label}: the review failed — ${done.error ?? 'see :reviews'}`;
        record(`reviewed ${target.label}: ${done.findings?.length ?? 0} finding(s)`);
        return describe(done);
      },
      approve: async (spec) => {
        const target = resolve(spec);
        if (typeof target === 'string') return target;
        const review = store.getReview(target.id);
        if (!review || !(review.doc || review.summary)) return `${target.label} has no colinear review — call review_pr first`;
        if (review.status === 'reviewing' || review.status === 'posting') return `${target.label} is still ${review.status}`;
        if (review.reviewedSha && review.headSha && review.reviewedSha !== review.headSha) {
          return `${target.label} has new commits since it was reviewed — review it again before approving`;
        }
        const asks = (review.findings ?? []).filter((f) => f.severity && ASKS_FOR_CHANGE.has(f.severity));
        if (asks.length) return `refused: ${target.label} has ${asks.length} finding(s) asking for a change — colinear approves only a clean review`;
        await this.reviewer.verdict(target.id, 'approve');
        const after = store.getReview(target.id);
        if (after?.status !== 'approved') return `${target.label}: approval failed — ${after?.error ?? 'unknown error'}`;
        record(`approved ${target.label}`);
        return `approved ${target.label}`;
      },
      comment: async (spec) => {
        const target = resolve(spec);
        if (typeof target === 'string') return target;
        const review = store.getReview(target.id);
        if (!review?.findings?.length) return `${target.label} has no findings to post`;
        await this.reviewer.post(target.id);
        const after = store.getReview(target.id);
        if (after?.status !== 'commented') return `${target.label}: posting failed — ${after?.error ?? 'unknown error'}`;
        record(`posted ${after.findings?.length ?? 0} comment(s) on ${target.label}`);
        return `posted the findings on ${target.label}`;
      },
    };
  }
}

/** A review as a job's agent reads it: summary, then each finding on a line. */
function describe(review: Review): string {
  const findings = review.findings ?? [];
  const lines = findings.map((f) => `- [${f.severity ?? 'lead'}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.comment.split('\n')[0]}`.trim());
  return [
    `${review.repository}#${review.number} — ${review.title}`,
    review.summary ? `\n${review.summary.trim()}` : '',
    `\n${findings.length} finding(s)${findings.length ? ':' : ''}`,
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');
}
