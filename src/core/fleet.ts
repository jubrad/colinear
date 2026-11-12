/**
 * Every agent and every task, in the order it wants you: stopped on a
 * question, stopped on something else only you can do, at work, waiting on
 * somebody else, just done. `:agents` and the rail beside every view both read
 * this, so the two never disagree about what is going on.
 *
 * Two sources, because neither holds the whole picture. The session registry
 * knows what is running and what just ended, but an agent that asked a
 * question has *ended* — its session is over until you answer — and so has
 * one that failed, opened a draft or was interrupted. So a task's row comes
 * from the store and the registry only says whether an agent is on it now;
 * sessions with no task behind them (plans, drafts) come from the registry.
 *
 * Pure: the view hands in the store's rows and the registry's, and gets rows
 * back. Nothing here talks to the daemon.
 */
import type { AgentSession } from './sessions.js';
import { questionSummary, type Review, type Task } from './types.js';

export type FleetGroup = 'needs' | 'yours' | 'running' | 'waiting' | 'finished';

export interface FleetEntry {
  /** stable across polls and across groups: what React keys on and the cursor follows */
  key: string;
  group: FleetGroup;
  /** what it is working on, as you would type it: CLO-203, cloud#902 */
  label: string;
  /** the session's kind while one runs; otherwise what state it is parked in */
  kind: string;
  /** the issue or PR title, when there is one */
  title?: string;
  /** one line on what is happening: the question, the last step, the next step */
  line: string;
  /** when it entered its group — asked, started, stopped — for its age and for unread */
  since: number;
  /** a finished session's outcome */
  ok?: boolean;
  task?: Task;
  review?: Review;
  agent?: AgentSession;
  /** the view that owns it, and the param that opens it there; none for a draft */
  open?: { view: string; param: string };
}

export const GROUP_LABEL: Record<FleetGroup, string> = {
  needs: 'needs you',
  yours: 'your move',
  running: 'working',
  waiting: 'waiting',
  finished: 'done',
};

/** How long a finished task stays in the list: long enough to notice it landed. */
export const DONE_MS = 60 * 60 * 1000;

/** owner/repo is noise in a list where the owner rarely varies */
const shortPr = (r: Review) => `${r.repository.split('/')[1] ?? r.repository}#${r.number}`;

function openFor(agent: AgentSession): FleetEntry['open'] {
  if (agent.kind === 'review') return { view: 'reviews', param: agent.label };
  if (agent.kind === 'plan') return { view: 'plan', param: agent.label };
  if (agent.kind.startsWith('draft') || agent.kind === 'todo') return undefined;
  return { view: 'task', param: agent.label };
}

type Step = { group: FleetGroup; kind: string; line: string; ok?: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where a task with no agent running on it is parked, and whose move that is.
 * "Yours" means nothing happens until you act — a failure, a draft to promote,
 * a PR to merge or fix. "Waiting" means somebody or something else moves next:
 * a blocker, a reviewer, CI, a free slot in the queue.
 */
export function nextStep(task: Task, now: number): Step | undefined {
  const pr = task.prs?.[0];
  const ci = pr?.checksStatus;
  if (task.awaitingStart) return { group: 'yours', kind: 'unstarted', line: 'worktree ready, no agent yet · r starts one' };
  if (task.proposals?.length) {
    return { group: 'yours', kind: 'proposals', line: `${plural(task.proposals.length, 'proposed sub-issue')} · enter to look them over` };
  }
  switch (task.status) {
    case 'needs_input':
      return { group: 'yours', kind: 'input', line: 'waiting on you · enter opens it' };
    case 'escalated':
      return { group: 'yours', kind: 'escalated', line: task.error ? `escalated: ${task.error}` : 'escalated · r resumes' };
    case 'error':
      return { group: 'yours', kind: 'failed', line: `failed: ${task.error ?? 'see the log'} · r resumes` };
    case 'interrupted':
      return { group: 'yours', kind: 'interrupted', line: 'stopped by a restart · r resumes' };
    case 'blocked': {
      const on = (task.blockedBy ?? []).filter((b) => !b.done).map((b) => b.identifier);
      return { group: 'waiting', kind: 'blocked', line: on.length ? `blocked by ${on.join(', ')} · f starts anyway` : 'blocked' };
    }
    case 'queued':
      return { group: 'waiting', kind: 'queued', line: 'queued for a free agent' };
    case 'checks':
      return { group: 'waiting', kind: 'checks', line: 'running checks' };
    case 'tracking': {
      const subs = task.subIssues ?? [];
      return { group: 'waiting', kind: 'tracking', line: `${subs.filter((s) => s.done).length}/${subs.length} sub-issues done` };
    }
    case 'done':
    case 'cancelled': {
      if (now - (task.endedAt ?? 0) > DONE_MS) return undefined;
      const merged = pr?.state === 'MERGED' ? `merged #${pr.number}` : undefined;
      return { group: 'finished', kind: task.status, line: merged ?? task.status, ok: task.status === 'done' };
    }
    case 'pr_open': {
      if (!pr) return { group: 'waiting', kind: 'pr', line: 'PR open' };
      const n = `#${pr.number}`;
      if (pr.state === 'MERGED') return { group: 'finished', kind: 'merged', line: `merged ${n}`, ok: true };
      if (pr.state === 'CLOSED') return { group: 'yours', kind: 'closed', line: `${n} closed unmerged` };
      if (pr.reviewDecision === 'CHANGES_REQUESTED') return { group: 'yours', kind: 'changes', line: `changes requested on ${n}` };
      if (pr.mergeable === 'CONFLICTING') return { group: 'yours', kind: 'conflict', line: `${n} conflicts with its base · b rebases` };
      if (ci === 'failing') return { group: 'yours', kind: 'ci', line: `CI failing on ${n}` };
      if (pr.reviewDecision === 'APPROVED') return { group: 'yours', kind: 'approved', line: `${n} approved · merge it · o opens` };
      if (pr.isDraft) {
        if (ci && ci !== 'passing') return { group: 'waiting', kind: 'draft', line: `draft ${n} · CI ${ci}` };
        return { group: 'yours', kind: 'draft', line: `draft ${n} ready · v reads it, then promote` };
      }
      return { group: 'waiting', kind: 'review', line: `${n} awaiting review${ci && ci !== 'passing' ? ` · CI ${ci}` : ''}` };
    }
    default:
      return undefined;
  }
}

export function fleet(tasks: Task[], reviews: Review[], agents: AgentSession[], now = Date.now()): FleetEntry[] {
  // the session to show for each label: a live one if there is one, else the newest
  const sessionFor = new Map<string, AgentSession>();
  for (const a of agents) {
    const had = sessionFor.get(a.label);
    const better =
      !had ||
      (a.status === 'running' && had.status !== 'running') ||
      ((a.status === 'running') === (had.status === 'running') && a.startedAt > had.startedAt);
    if (better) sessionFor.set(a.label, a);
  }
  const liveFor = (label: string) => {
    const a = sessionFor.get(label);
    return a?.status === 'running' ? a : undefined;
  };
  const out: FleetEntry[] = [];
  const covered = new Set<string>();

  for (const t of tasks) {
    const label = t.issue.identifier;
    const session = sessionFor.get(label);
    const live = liveFor(label);
    const base = {
      key: `task:${t.issue.id}`,
      label,
      title: t.issue.title,
      task: t,
      agent: session,
      open: { view: 'task', param: label },
    };
    if (t.status === 'needs_input' && t.question) {
      covered.add(label);
      out.push({
        ...base,
        group: 'needs',
        kind: 'question',
        line: questionSummary(t.question),
        // the session that asked ended when it asked: its end is when the question landed
        since: session?.endedAt ?? t.endedAt ?? t.startedAt ?? 0,
      });
      continue;
    }
    if (live) {
      covered.add(label);
      out.push({ ...base, group: 'running', kind: live.kind, line: live.activity ?? 'starting…', since: live.startedAt });
      continue;
    }
    const step = nextStep(t, now);
    if (step) {
      covered.add(label);
      // a session that just ended on this task says how it went better than the status does
      const ended = session && step.group === 'finished' ? session.result?.summary : undefined;
      out.push({
        ...base,
        group: step.group,
        kind: step.kind,
        line: ended ?? step.line,
        since: t.endedAt ?? t.startedAt ?? 0,
        ok: step.ok,
      });
      continue;
    }
    // working or triage with no session: between turns, or about to start
    if (['working', 'triage'].includes(t.status)) {
      covered.add(label);
      out.push({ ...base, group: 'running', kind: t.status === 'triage' ? 'triage' : 'work', line: t.activity.at(-1) ?? 'starting…', since: t.startedAt ?? 0 });
    }
  }

  for (const r of reviews) {
    const session = sessionFor.get(r.id);
    const live = liveFor(r.id);
    const base = { key: `review:${r.id}`, label: shortPr(r), title: r.title, review: r, agent: session, open: { view: 'reviews', param: r.id } };
    if (r.question) {
      covered.add(r.id);
      out.push({ ...base, group: 'needs', kind: 'question', line: questionSummary(r.question), since: session?.endedAt ?? r.endedAt ?? r.startedAt ?? 0 });
    } else if (live) {
      covered.add(r.id);
      out.push({ ...base, group: 'running', kind: 'review', line: live.activity ?? 'starting…', since: live.startedAt });
    } else if (r.status === 'ready' && r.requested !== false) {
      covered.add(r.id);
      const n = r.findings?.length ?? 0;
      out.push({ ...base, group: 'yours', kind: 'review', line: `pre-review ready · ${plural(n, 'finding')} to post`, since: r.endedAt ?? r.startedAt ?? 0 });
    } else if (r.status === 'error') {
      covered.add(r.id);
      out.push({ ...base, group: 'yours', kind: 'review', line: 'pre-review failed · enter opens it', since: r.endedAt ?? r.startedAt ?? 0, ok: false });
    }
  }

  // plans, drafts, a review that just posted: anything still in the registry with no row above
  const shown = new Set<string>();
  for (const a of [...agents].sort((x, y) => y.startedAt - x.startedAt)) {
    if (covered.has(a.label) || shown.has(a.label)) continue;
    shown.add(a.label);
    const live = a.status === 'running';
    const review = reviews.find((r) => r.id === a.label);
    out.push({
      key: review ? `review:${review.id}` : `agent:${a.id}`,
      group: live ? 'running' : 'finished',
      label: review ? shortPr(review) : a.label,
      kind: a.kind,
      title: review?.title,
      line: a.result?.summary ?? a.activity ?? (live ? 'starting…' : 'finished'),
      since: live ? a.startedAt : (a.endedAt ?? a.startedAt),
      ok: live ? undefined : (a.result?.ok ?? a.status !== 'error'),
      review,
      agent: a,
      open: openFor(a),
    });
  }

  const ORDER: FleetGroup[] = ['needs', 'yours', 'running', 'waiting', 'finished'];
  return out.sort((a, b) => {
    const g = ORDER.indexOf(a.group) - ORDER.indexOf(b.group);
    if (g) return g;
    // done: most recent first; everything else: longest-waiting first
    return a.group === 'finished' ? b.since - a.since : a.since - b.since;
  });
}

/**
 * Has something happened here since you last opened it? A question asked, an
 * agent started, a session finished — each after the last time you looked.
 * `seen` is keyed by what opens the entry, the same param navigation uses.
 */
export function isUnread(entry: FleetEntry, seen: Record<string, number> | undefined): boolean {
  if (!entry.open) return false;
  return (seen?.[entry.open.param] ?? 0) < entry.since;
}

/** The views that open one thing, and so count as having looked at it. */
const LOOKING = new Set(['task', 'diff', 'reviews', 'plan']);

/**
 * The seen-map after opening `view(param)`: stamped now, and pruned to the most
 * recent entries so a year of use does not grow a file the daemon rewrites on
 * every patch.
 */
export function markSeen(
  seen: Record<string, number> | undefined,
  view: string,
  param: string | undefined,
  now: number,
): Record<string, number> | undefined {
  if (!param || !LOOKING.has(view)) return undefined;
  // `:reviews doc:<id>` is the same review as `:reviews <id>`
  const key = param.startsWith('doc:') ? param.slice(4) : param;
  const next = Object.entries({ ...seen, [key]: now })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200);
  return Object.fromEntries(next);
}

/** "4m", "2h", "now" — how long an entry has been where it is. */
export function age(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
