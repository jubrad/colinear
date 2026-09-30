import type {
  Issue,
  Project,
  Review,
  Task,
  TodoConfig,
  TodoFacts,
  TodoItem,
  TodoUrgency,
} from './types.js';
import { questionSummary } from './types.js';

/**
 * :todo, the pure half: every source reduced to one shape (`TodoItem`), a
 * score for each, and the prompt that asks an agent to put them in order.
 *
 * Nothing here reads the network or the store — the daemon gathers, this
 * decides — so `todo.check.ts` can hold the scoring to its word with fixed
 * inputs and a fixed clock.
 *
 * The score is colinear's own order, and it is shown before the agent
 * answers (and instead of it, when it fails). It is deliberately simple: the
 * point of the agent is the judgement a weighted sum can't make — that a
 * two-line PR from someone blocked is worth more than a large one that isn't,
 * or that three issues due the same day are really one milestone.
 */

export interface TodoSources {
  tasks: Task[];
  reviews: Review[];
  /** open issues assigned to the operator, fresh from the tracker */
  issues: Issue[];
  /** open projects, for target dates and priority by id */
  projects: Project[];
  /** the operator's display name in the tracker — a project's `lead` is compared against it */
  viewerName?: string;
  now: number;
  cfg: TodoConfig;
  /** the config's ciAutofix: with it on, a red PR is the babysitter's until it gives up */
  ciAutofix?: boolean;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Hours between two instants, not counting Saturday or Sunday (local time).
 *
 * A review SLA is a working-day promise: a request that lands on Friday
 * afternoon is not a day late on Monday morning, and a list that says it is
 * would open every week by crying wolf.
 */
export function workingHoursBetween(from: number, to: number): number {
  if (!(to > from)) return 0;
  let ms = 0;
  let t = from;
  while (t < to) {
    const d = new Date(t);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const end = Math.min(midnight, to);
    const day = d.getDay();
    if (day !== 0 && day !== 6) ms += end - t;
    t = end;
  }
  return ms / HOUR;
}

/**
 * Whole calendar days from today to an ISO day ("2026-10-03"), negative when
 * it has passed. Trackers store these dates without a time, so they are read
 * as local midnight — parsing them as UTC would move every deadline a day for
 * anyone west of Greenwich.
 */
export function daysUntil(iso: string, now: number): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((due - start) / DAY);
}

/** "31h", "2d 4h" — short enough for a why, precise enough to check. */
export function formatHours(hours: number): string {
  const h = Math.round(hours);
  if (h < 1) return 'under an hour';
  if (h < 48) return `${h}h`;
  const days = Math.floor(h / 24);
  const rest = h % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** "Oct 3" — the day, in the operator's locale. */
function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function inDays(days: number): string {
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return 'a day overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

const PRIORITY_WORD: Record<number, string> = { 1: 'Urgent', 2: 'High priority', 3: 'Medium priority', 4: 'Low priority' };

// ── reviews ────────────────────────────────────────────────────────────────

const PRE_REVIEW_LIVE = new Set(['queued', 'reviewing', 'posting']);

/**
 * A pull request waiting on your review, as a todo entry — or undefined when
 * the ball is not in your court. Exported for the view: the same rule that
 * put an entry on the list is what notices you have dealt with it.
 */
export function reviewNeed(review: Review, cfg: TodoConfig, now: number): TodoItem | undefined {
  if (review.status === 'stale') return undefined;
  // posted, or adopted without a request (your own PR): nothing is asked of you
  if (!review.requested) return undefined;

  const start = Date.parse(review.requestedAt ?? review.createdAt ?? review.updatedAt);
  const waiting = Number.isFinite(start) ? workingHoursBetween(start, now) : 0;
  const untouched = (now - Date.parse(review.updatedAt)) / DAY;
  const stale = review.isDraft || untouched >= cfg.staleDays;
  const ratio = waiting / cfg.reviewSlaHours;
  const viaTeam = review.requestedVia === 'team';

  // 60 at the moment it is asked, 110 at the SLA, 160 at twice it — a review
  // climbs past everything but an urgent deadline or a waiting agent the day
  // it goes late. Past that it keeps creeping, a point per further working
  // day up to 170, so the oldest request still comes first rather than tying
  // with last week's. A team request is discounted — someone else on the team
  // may well take it — but climbs all the same.
  const beyond = Math.max(0, waiting - 2 * cfg.reviewSlaHours) / 24;
  let score = stale ? 5 : 60 + 50 * Math.min(ratio, 2) + Math.min(beyond, 10);
  if (viaTeam && !stale) score *= 0.8;

  const urgency: TodoUrgency = stale ? 'later' : ratio >= 1 ? 'now' : 'today';
  const sla = `${formatHours(cfg.reviewSlaHours)} review SLA`;
  const why = stale
    ? review.isDraft
      ? 'Still a draft — the review clock is paused until it is marked ready.'
      : `Untouched for ${Math.floor(untouched)} days — stale, so it has stopped climbing.`
    : ratio >= 1
      ? `Waiting ${formatHours(waiting)}, ${formatHours(waiting - cfg.reviewSlaHours)} past the ${sla}${viaTeam ? ' (asked of your team)' : ''}.`
      : `Waiting ${formatHours(waiting)} of the ${sla}${viaTeam ? ' (asked of your team)' : ''}.`;

  const action = review.status === 'ready'
    ? 'Read the pre-review and post it'
    : stale
      ? review.isDraft
        ? 'Nothing until it is ready'
        : 'Nudge the author or drop it'
      : 'Review it';

  const name = review.repository.split('/')[1] ?? review.repository;
  const facts: TodoFacts = {
    waitingHours: Math.round(waiting * 10) / 10,
    slaHours: cfg.reviewSlaHours,
    stale,
    author: review.author,
    size: `+${review.additions}/-${review.deletions}, ${review.changedFiles} file${review.changedFiles === 1 ? '' : 's'}`,
    via: review.requestedVia,
    ...(review.status === 'ready'
      ? { note: 'a pre-review is written and waiting for you' }
      : PRE_REVIEW_LIVE.has(review.status)
        ? { note: 'a pre-review agent is on it' }
        : {}),
  };
  return {
    key: `review:${review.id}`,
    kind: 'review',
    ref: `${name}#${review.number}`,
    title: review.title,
    action,
    why,
    urgency,
    facts,
    url: review.url,
    open: { view: 'reviews', param: review.id },
    score: round(score),
  };
}

// ── tasks ──────────────────────────────────────────────────────────────────

/** Statuses where an agent, not you, is the one holding it. */
const AGENT_HOLDS = new Set(['queued', 'triage', 'working', 'checks', 'blocked']);

/**
 * A colinear task that is waiting on you, or undefined when it isn't — an
 * agent working, a PR in someone else's review, work that has landed.
 * `issue` is the tracker's fresh copy when there is one: a task's own is
 * frozen at dispatch, and priority and milestones move.
 */
export function taskNeed(task: Task, issue: Issue | undefined, ctx: DeadlineContext): TodoItem | undefined {
  const i = issue ?? task.issue;
  const base = { key: `task:${task.issue.id}`, kind: 'task' as const, ref: i.identifier, title: i.title, url: i.url };
  const open = { view: 'task', param: i.identifier };
  const status = task.status;
  const need = ((): { score: number; urgency: TodoUrgency; action: string; why: string; note?: string } | undefined => {
    if (task.maintenance || task.reviewing) return undefined; // an agent is on it where it sits
    if (status === 'needs_input' && task.question) {
      const permission = task.question.kind === 'permission';
      // above the oldest review (170): an agent asking is a whole session idle
      return {
        score: 180,
        urgency: 'now',
        action: permission ? 'Allow or deny the tool call' : 'Answer the agent',
        why: `The agent has stopped to ask: ${questionSummary(task.question)}`,
        note: questionSummary(task.question),
      };
    }
    if (status === 'needs_input' || status === 'escalated') {
      return {
        score: 110,
        urgency: 'today',
        action: task.verdict?.verdict === 'too_big' ? 'Review the proposed split' : 'Decide how it proceeds',
        why: task.verdict?.reason
          ? `Triage parked it: ${task.verdict.reason}`
          : 'Parked waiting for a decision from you.',
        note: task.verdict?.reason,
      };
    }
    if (status === 'error') {
      return {
        score: 100,
        urgency: 'today',
        action: 'Look at the failure',
        why: `The session failed${task.error ? `: ${task.error.slice(0, 140)}` : '.'}`,
        note: task.error?.slice(0, 200),
      };
    }
    if (status === 'tracking' && task.proposals?.length) {
      return {
        score: 80,
        urgency: 'today',
        action: 'Review the proposed sub-issues',
        why: `The coordinator proposed ${task.proposals.length} sub-issue${task.proposals.length === 1 ? '' : 's'}; nothing is created until you approve.`,
      };
    }
    if (status === 'pr_open') {
      const pr = task.prs.find((p) => p.state === 'OPEN');
      if (!pr) return undefined;
      if (pr.reviewDecision === 'CHANGES_REQUESTED') {
        return { score: 95, urgency: 'today', action: 'Address the review', why: `Changes were requested on #${pr.number}.`, note: 'changes requested' };
      }
      if (pr.checksStatus === 'failing' && (!ctx.ciAutofix || task.ciFixAttempted)) {
        return { score: 85, urgency: 'today', action: 'Fix CI', why: `Checks are red on #${pr.number}${task.ciFixAttempted ? ' and the automatic fix did not clear them' : ''}.`, note: 'checks failing' };
      }
      if (pr.mergeable === 'CONFLICTING' && task.rebaseAttempted) {
        return { score: 80, urgency: 'today', action: 'Resolve the conflict', why: `#${pr.number} conflicts with its base and the automatic rebase did not land.`, note: 'conflicting' };
      }
      const heldByBlocker = task.blockedBy?.some((b) => b.kind === 'merge' && !b.done);
      if (pr.isDraft && pr.checksStatus !== 'failing' && pr.checksStatus !== 'running' && !heldByBlocker) {
        return { score: 90, urgency: 'today', action: 'Read the diff and promote the draft', why: `Draft #${pr.number} is done and green; it goes to reviewers when you promote it.`, note: 'draft ready' };
      }
      if (!pr.isDraft && pr.reviewDecision === 'APPROVED' && pr.checksStatus !== 'failing') {
        return { score: 85, urgency: 'today', action: 'Merge it', why: `#${pr.number} is approved.`, note: 'approved' };
      }
      return undefined; // in review: someone else's move
    }
    if (status === 'interrupted') {
      return { score: 45, urgency: 'week', action: 'Resume it', why: 'Interrupted mid-session; r picks the conversation back up.' };
    }
    if (status === 'working' && task.awaitingStart) {
      return { score: 50, urgency: 'week', action: 'Lay the skeleton down, then start it', why: 'Dispatched by hand — the worktree is waiting for you.' };
    }
    return undefined;
  })();
  if (!need) return undefined;
  // the issue's own weight rides along, at half strength: an urgent issue's
  // failed session outranks a low one's, but a question is a question
  const weight = issueWeight(i, ctx);
  return {
    ...base,
    action: need.action,
    why: need.why,
    urgency: sooner(need.urgency, weight.urgency),
    facts: { ...weight.facts, status, ...(need.note ? { note: need.note } : {}) },
    open,
    score: round(need.score + weight.score / 2),
  };
}

// ── issues, milestones, projects ─────────────────────────────────────────────

export interface DeadlineContext {
  projects: Map<string, Project>;
  horizonDays: number;
  ciAutofix: boolean;
  now: number;
}

/** 1 urgent … 4 low; 0 (none) sits just above low, since "unset" is not "unimportant". */
const PRIORITY_SCORE: Record<number, number> = { 1: 90, 2: 65, 3: 40, 4: 20, 0: 30 };

/** How much a deadline adds: steep inside a week, nothing past the horizon. */
function deadlineScore(days: number | undefined, horizon: number): number {
  if (days === undefined) return 0;
  if (days < 0) return 70;
  if (days <= 2) return 55;
  if (days <= 7) return 35;
  if (days <= 14) return 20;
  if (days <= horizon) return 10;
  return 0;
}

function deadlineUrgency(days: number | undefined): TodoUrgency {
  if (days === undefined) return 'later';
  if (days < 0) return 'now';
  if (days <= 2) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

const URGENCY_ORDER: TodoUrgency[] = ['now', 'today', 'week', 'later'];
const sooner = (a: TodoUrgency, b: TodoUrgency): TodoUrgency =>
  URGENCY_ORDER.indexOf(a) <= URGENCY_ORDER.indexOf(b) ? a : b;

/** The nearest date that bears on an issue, and whose it is. */
function nearestDeadline(
  issue: Issue,
  project: Project | undefined,
  now: number,
): { due?: string; dueFrom?: TodoFacts['dueFrom']; days?: number } {
  const dates: Array<[string | undefined, TodoFacts['dueFrom']]> = [
    [issue.dueDate, 'issue'],
    [issue.milestoneTargetDate, 'milestone'],
    [project?.targetDate, 'project'],
  ];
  let best: { due?: string; dueFrom?: TodoFacts['dueFrom']; days?: number } = {};
  for (const [date, from] of dates) {
    if (!date) continue;
    const days = daysUntil(date, now);
    if (days === undefined) continue;
    if (best.days === undefined || days < best.days) best = { due: date, dueFrom: from, days };
  }
  return best;
}

/** What an issue weighs on its own: priority, deadline, whether it's under way. */
export function issueWeight(
  issue: Issue,
  ctx: DeadlineContext,
): { score: number; urgency: TodoUrgency; facts: TodoFacts; reasons: string[] } {
  const project = issue.projectId ? ctx.projects.get(issue.projectId) : undefined;
  const deadline = nearestDeadline(issue, project, ctx.now);
  const started = issue.stateType === 'started';
  const projectPriority = project?.priority || undefined;
  let score = PRIORITY_SCORE[issue.priority] ?? 30;
  score += deadlineScore(deadline.days, ctx.horizonDays);
  if (started) score += 15;
  if (issue.stateType === 'backlog') score -= 10;
  if (projectPriority === 1) score += 15;
  else if (projectPriority === 2) score += 8;

  let urgency = deadlineUrgency(deadline.days);
  if (issue.priority === 1) urgency = sooner(urgency, 'today');
  else if (issue.priority === 2) urgency = sooner(urgency, 'week');

  const reasons: string[] = [];
  if (PRIORITY_WORD[issue.priority]) reasons.push(PRIORITY_WORD[issue.priority]);
  if (deadline.due && deadline.days !== undefined && deadline.days <= ctx.horizonDays) {
    const whose =
      deadline.dueFrom === 'milestone'
        ? ` (milestone ${issue.milestoneName})`
        : deadline.dueFrom === 'project'
          ? ` (project ${project?.name})`
          : '';
    reasons.push(`due ${formatDay(deadline.due)}${whose}, ${inDays(deadline.days)}`);
  }
  if (started) reasons.push(`already ${issue.stateName}`);
  if (projectPriority && projectPriority <= 2) reasons.push(`in a ${PRIORITY_WORD[projectPriority]!.toLowerCase()} project`);

  return {
    score,
    urgency,
    reasons,
    facts: {
      priority: issue.priority,
      ...(projectPriority ? { projectPriority } : {}),
      ...(issue.projectName || project ? { project: issue.projectName ?? project?.name } : {}),
      ...(issue.milestoneName ? { milestone: issue.milestoneName } : {}),
      ...(deadline.due ? { due: deadline.due, dueFrom: deadline.dueFrom, daysToDue: deadline.days } : {}),
      state: issue.stateName,
      started,
    },
  };
}

function issueItem(issue: Issue, ctx: DeadlineContext): TodoItem {
  const weight = issueWeight(issue, ctx);
  const sentence = weight.reasons.length ? `${capitalize(weight.reasons.join(', '))}.` : 'Assigned to you, no priority or date.';
  return {
    key: `issue:${issue.id}`,
    kind: 'issue',
    ref: issue.identifier,
    title: issue.title,
    action: weight.facts.started ? 'Keep it moving' : 'Pick it up or dispatch it',
    why: sentence,
    urgency: weight.urgency,
    facts: weight.facts,
    url: issue.url,
    // no task yet, so the tracker is where it lives
    open: { view: 'issues' },
    score: round(weight.score),
  };
}

/**
 * A milestone several of your issues are racing: three issues due Friday are
 * one deadline, and read as three unrelated rows otherwise. Only when two or
 * more share it — one issue already carries its own date.
 */
function milestoneItems(issues: Issue[], ctx: DeadlineContext): TodoItem[] {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.projectId || !issue.milestoneName || !issue.milestoneTargetDate) continue;
    const key = `${issue.projectId}:${issue.milestoneName}`;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const out: TodoItem[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const first = group[0];
    const days = daysUntil(first.milestoneTargetDate!, ctx.now);
    if (days === undefined || days > ctx.horizonDays) continue;
    const project = ctx.projects.get(first.projectId!);
    const projectName = first.projectName ?? project?.name ?? 'project';
    out.push({
      key: `milestone:${key}`,
      kind: 'milestone',
      ref: first.milestoneName!,
      title: `${projectName} · ${first.milestoneName}`,
      action: days < 0 ? 'Re-plan it or move the date' : 'Check it will land',
      why: `${group.length} of your open issues are in it, due ${formatDay(first.milestoneTargetDate!)} — ${inDays(days)}.`,
      urgency: deadlineUrgency(days),
      facts: {
        project: projectName,
        milestone: first.milestoneName,
        due: first.milestoneTargetDate,
        dueFrom: 'milestone',
        daysToDue: days,
        openIssues: group.length,
        ...(project?.priority ? { projectPriority: project.priority } : {}),
      },
      open: { view: 'project', param: first.projectId },
      score: round(deadlineScore(days, ctx.horizonDays) * 1.2 + 8 * Math.min(group.length, 5)),
    });
  }
  return out;
}

/** Projects you lead whose target date is inside the horizon and not done. */
function projectItems(sources: TodoSources, ctx: DeadlineContext): TodoItem[] {
  if (!sources.viewerName) return [];
  const me = sources.viewerName.toLowerCase();
  const out: TodoItem[] = [];
  for (const project of sources.projects) {
    if (project.lead?.toLowerCase() !== me || !project.targetDate || project.progress >= 1) continue;
    const days = daysUntil(project.targetDate, ctx.now);
    if (days === undefined || days > ctx.horizonDays) continue;
    const pct = Math.round(project.progress * 100);
    out.push({
      key: `project:${project.id}`,
      kind: 'project',
      ref: project.name,
      title: project.name,
      action: days < 0 ? 'Re-plan it or move the date' : 'Check it will land on time',
      why: `You lead it; it targets ${formatDay(project.targetDate)} (${inDays(days)}) and is ${pct}% done.`,
      urgency: deadlineUrgency(days),
      facts: {
        project: project.name,
        due: project.targetDate,
        dueFrom: 'project',
        daysToDue: days,
        progress: project.progress,
        ...(project.priority ? { projectPriority: project.priority } : {}),
        state: project.state,
      },
      url: project.url,
      open: { view: 'project', param: project.id },
      score: round(
        deadlineScore(days, ctx.horizonDays) * (1.5 - project.progress) +
          (project.priority === 1 ? 15 : project.priority === 2 ? 8 : 0),
      ),
    });
  }
  return out;
}

// ── the whole list ──────────────────────────────────────────────────────────

/** Tasks that are over: an issue with one of these is back to being just an issue. */
const TASK_OVER = new Set(['done', 'cancelled']);

/**
 * Every candidate, best-scored first. An issue with a live task appears as the
 * task (if it needs you) or not at all (if an agent has it) — never both,
 * because "pick up CLO-12" next to "answer the agent on CLO-12" is one thing
 * said twice.
 */
export function buildCandidates(sources: TodoSources): TodoItem[] {
  const ctx: DeadlineContext = {
    projects: new Map(sources.projects.map((p) => [p.id, p])),
    horizonDays: sources.cfg.horizonDays,
    ciAutofix: sources.ciAutofix ?? true,
    now: sources.now,
  };
  const fresh = new Map(sources.issues.map((i) => [i.id, i]));
  const live = new Set(sources.tasks.filter((t) => !TASK_OVER.has(t.status)).map((t) => t.issue.id));
  const items: TodoItem[] = [];
  for (const review of sources.reviews) {
    const item = reviewNeed(review, sources.cfg, sources.now);
    if (item) items.push(item);
  }
  for (const task of sources.tasks) {
    const item = taskNeed(task, fresh.get(task.issue.id), ctx);
    if (item) items.push(item);
  }
  // an issue that is only an issue: not closed, not under a live task, and
  // not a tracking parent's children being handled elsewhere
  const standalone = sources.issues.filter(
    (i) => !live.has(i.id) && i.stateType !== 'completed' && i.stateType !== 'canceled',
  );
  for (const issue of standalone) items.push(issueItem(issue, ctx));
  items.push(...milestoneItems(standalone, ctx));
  items.push(...projectItems(sources, ctx));
  return items.sort((a, b) => b.score - a.score || urgencyRank(a) - urgencyRank(b) || a.ref.localeCompare(b.ref));
}

const urgencyRank = (item: TodoItem) => URGENCY_ORDER.indexOf(item.urgency);

/**
 * Has an entry been dealt with since the list was made? The list is a
 * snapshot, and working down it should tick things off rather than leave
 * them sitting there looking undone until the next refresh. Asked of the
 * live store with the same rules that put the entry there, so "handled" means
 * exactly "would no longer be listed". Undefined = still wants you.
 */
export function handledReason(
  item: TodoItem,
  live: {
    task: (id: string) => Task | undefined;
    review: (id: string) => Review | undefined;
    tasks: () => Task[];
  },
  cfg: TodoConfig,
  now: number,
  ciAutofix = true,
): string | undefined {
  const [kind, ...rest] = item.key.split(':');
  const id = rest.join(':');
  if (kind === 'review') {
    const review = live.review(id);
    if (!review || review.status === 'stale') return 'settled';
    if (!review.requested) return review.posted ? 'reviewed' : 'no longer asked';
    return undefined;
  }
  if (kind === 'task') {
    const task = live.task(id);
    if (!task || TASK_OVER.has(task.status)) return 'done';
    if (AGENT_HOLDS.has(task.status) && !task.awaitingStart) return 'agent on it';
    const ctx: DeadlineContext = { projects: new Map(), horizonDays: cfg.horizonDays, ciAutofix, now };
    // the question was answered, the PR was promoted, the failure was retried
    if (!taskNeed(task, undefined, ctx)) return 'handled';
    return undefined;
  }
  if (kind === 'issue') {
    const task = live.tasks().find((t) => t.issue.id === id && !TASK_OVER.has(t.status));
    return task ? 'dispatched' : undefined;
  }
  return undefined;
}

// ── the ranking agent ──────────────────────────────────────────────────────

/**
 * How to weigh things — the part of the prompt `todo.prompt` replaces. Kept
 * separate from the data and the answer format, which are colinear's
 * business: replacing those would only stop the answer from parsing.
 */
export const DEFAULT_TODO_POLICY = `Balance three pressures, roughly in this order:

1. Pull request reviews. Reviews are owed promptly — about one working day (slaHours). The longer a request has been waiting, the higher it goes: one past its SLA outranks everything except an agent stopped on a question or an urgent, overdue deadline. Among reviews, the longest-waiting goes first; a small PR can jump ahead because it costs little to clear. A stale PR (a draft, or untouched for a long time) is the exception: its clock has stopped, so it goes to the bottom or off the list.
2. Deadlines. Milestone and project target dates, and issue due dates. Overdue, or due within a couple of days, ranks high; a week out matters; a date weeks away barely does. Several issues racing one milestone are one deadline — weigh the milestone.
3. Priority. Issue and project priority (1 urgent, 2 high, 3 medium, 4 low, 0 none). Urgent work outranks deadlines further out; low priority with no date is "later".

Agents waiting on the operator — a question, a failure, a draft PR ready to promote — are cheap to unblock and keep work moving, so they sit near the top. At equal weight, finish started work before starting new work.`;

export const TODO_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          action: { type: 'string' },
          why: { type: 'string' },
          urgency: { type: 'string', enum: ['now', 'today', 'week', 'later'] },
        },
        required: ['key', 'action', 'why', 'urgency'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'items'],
  additionalProperties: false,
};

/** The prompt: policy (configurable), then what the data means and how to answer (not). */
export function rankPrompt(cfg: TodoConfig, candidates: TodoItem[], now: number, viewerName?: string): string {
  const when = new Date(now).toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const lines = candidates.map((c) =>
    JSON.stringify({
      key: c.key,
      kind: c.kind,
      ref: c.ref,
      title: c.title,
      score: c.score,
      urgency: c.urgency,
      facts: c.facts,
    }),
  );
  return `You are ordering a todo list for ${viewerName ?? 'the operator'}, an engineer who reviews pull requests, owns issues and projects in their tracker, and runs coding agents through colinear. It is ${when}.

Decide what they should do next, most pressing first.

## Policy
${cfg.prompt ?? DEFAULT_TODO_POLICY}${cfg.guidance ? `\n\n${cfg.guidance}` : ''}

## What you are given
One JSON object per line below. Each is something that may need the operator:
- kind: review (someone's PR awaiting their review) · task (a colinear agent's work waiting on them) · issue (assigned to them, no agent on it) · milestone (several of their issues share its date) · project (one they lead, with a target date close)
- score and urgency: colinear's own guess from simple rules — a starting point, not the answer
- facts.priority / projectPriority: 1 urgent, 2 high, 3 medium, 4 low, 0 none
- facts.due, daysToDue, dueFrom: the nearest deadline, whole days to it (negative = overdue), and whose date it is
- facts.waitingHours / slaHours: for a review, working hours since the request (weekends don't count) and the turnaround owed
- facts.stale: the review's clock has stopped — a draft, or untouched for ${cfg.staleDays} days
- facts.status / note: a task's colinear status, and the agent's question, error or PR state
- facts.size, author, via: a review's diff size, who wrote it, and whether it was asked of them by name or through a team

## Answer
- items: the candidates worth their attention, most pressing first. Leave out what doesn't need them — don't pad the list. For each:
  - key: exactly as given. Anything else is discarded.
  - action: the next move, imperative, under eight words
  - why: one sentence citing the facts that put it where it is
  - urgency: now · today · week · later
- summary: one or two sentences on the shape of the day — what to do first, and what can wait.

Everything you need is below; do not use tools.

## Candidates
${lines.join('\n')}`;
}

export interface RankAnswer {
  summary?: string;
  items?: Array<{ key?: string; action?: string; why?: string; urgency?: string }>;
}

/**
 * Lay the agent's order over the candidates. It chooses order, wording and
 * urgency; the entries themselves — what they point at, their facts, their
 * links — come from colinear. A key it made up is dropped and counted rather
 * than shown, and a duplicate keeps its first place.
 */
export function applyRanking(candidates: TodoItem[], answer: RankAnswer): { items: TodoItem[]; unknown: number } {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  let unknown = 0;
  for (const entry of answer.items ?? []) {
    const candidate = entry.key ? byKey.get(entry.key) : undefined;
    if (!candidate) {
      unknown++;
      continue;
    }
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    items.push({
      ...candidate,
      action: entry.action?.trim() || candidate.action,
      why: entry.why?.trim() || candidate.why,
      urgency: URGENCY_ORDER.includes(entry.urgency as TodoUrgency) ? (entry.urgency as TodoUrgency) : candidate.urgency,
    });
  }
  return { items, unknown };
}

/**
 * The answer, from structured output where the runtime has it, else the last
 * JSON object in the text — a runtime without structured output still gets
 * the schema in its prompt and usually complies.
 */
export function parseAnswer(structured: unknown, text: string): RankAnswer | undefined {
  if (structured && typeof structured === 'object') return structured as RankAnswer;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RankAnswer) : undefined;
  } catch {
    return undefined;
  }
}

const round = (n: number) => Math.round(n * 10) / 10;
const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
