/**
 * Every agent, in the order it wants you: the ones stopped on a question, the
 * ones at work, the ones that just finished. `:agents` and the rail beside
 * every view both read this, so the two never disagree about what is going on.
 *
 * Two sources, because neither holds the whole picture. The session registry
 * knows what is running and what just ended, but an agent that asked a
 * question has *ended* — its session is over until you answer — so the ones
 * waiting on you come from the store: tasks and reviews holding a question.
 *
 * Pure: the view hands in the store's rows and the registry's, and gets rows
 * back. Nothing here talks to the daemon.
 */
import type { AgentSession } from './sessions.js';
import { questionSummary, type Review, type Task } from './types.js';

export type FleetGroup = 'needs' | 'running' | 'finished';

export interface FleetEntry {
  /** stable across polls: what React keys on and the cursor follows */
  key: string;
  group: FleetGroup;
  /** what it is working on, as you would type it: CLO-203, cloud#902 */
  label: string;
  kind: string;
  /** the issue or PR title, when there is one */
  title?: string;
  /** one line on what is happening: the question, the last step, the outcome */
  line: string;
  /** when it entered its group — asked, started, finished — for its age and for unread */
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
  running: 'working',
  finished: 'just finished',
};

/** owner/repo is noise in a list where the owner rarely varies */
const shortPr = (r: Review) => `${r.repository.split('/')[1] ?? r.repository}#${r.number}`;

function openFor(agent: AgentSession): FleetEntry['open'] {
  if (agent.kind === 'review') return { view: 'reviews', param: agent.label };
  if (agent.kind === 'plan') return { view: 'plan', param: agent.label };
  if (agent.kind.startsWith('draft') || agent.kind === 'todo') return undefined;
  return { view: 'task', param: agent.label };
}

export function fleet(tasks: Task[], reviews: Review[], agents: AgentSession[]): FleetEntry[] {
  const byIdentifier = new Map(tasks.map((t) => [t.issue.identifier, t]));
  const reviewById = new Map(reviews.map((r) => [r.id, r]));
  // the session that asked: it ended when it asked, so its end is when the question landed
  const lastSession = new Map<string, AgentSession>();
  for (const a of agents) {
    const had = lastSession.get(a.label);
    if (!had || a.startedAt > had.startedAt) lastSession.set(a.label, a);
  }

  const needs: FleetEntry[] = [];
  for (const t of tasks) {
    if (t.status !== 'needs_input' || !t.question) continue;
    const label = t.issue.identifier;
    needs.push({
      key: `task:${t.issue.id}`,
      group: 'needs',
      label,
      kind: 'question',
      title: t.issue.title,
      line: questionSummary(t.question),
      since: lastSession.get(label)?.endedAt ?? t.endedAt ?? t.startedAt ?? 0,
      task: t,
      agent: lastSession.get(label),
      open: { view: 'task', param: label },
    });
  }
  for (const r of reviews) {
    if (!r.question) continue;
    needs.push({
      key: `review:${r.id}`,
      group: 'needs',
      label: shortPr(r),
      kind: 'question',
      title: r.title,
      line: questionSummary(r.question),
      since: lastSession.get(r.id)?.endedAt ?? r.endedAt ?? r.startedAt ?? 0,
      review: r,
      agent: lastSession.get(r.id),
      open: { view: 'reviews', param: r.id },
    });
  }

  const waiting = new Set(needs.map((e) => e.open?.param));
  const running: FleetEntry[] = [];
  const finished: FleetEntry[] = [];
  const shown = new Set<string>();
  // newest first, so a label with an old finished session and a live one shows the live one
  for (const a of [...agents].sort((x, y) => y.startedAt - x.startedAt)) {
    const open = openFor(a);
    if (open && waiting.has(open.param)) continue;
    const live = a.status === 'running';
    // one row per thing being worked on: a later session supersedes an earlier one
    if (shown.has(a.label)) continue;
    shown.add(a.label);
    const task = byIdentifier.get(a.label);
    const review = reviewById.get(a.label);
    const entry: FleetEntry = {
      key: `agent:${a.id}`,
      group: live ? 'running' : 'finished',
      label: review ? shortPr(review) : a.label,
      kind: a.kind,
      title: task?.issue.title ?? review?.title,
      line: a.result?.summary ?? a.activity ?? (live ? 'starting…' : 'finished'),
      since: live ? a.startedAt : (a.endedAt ?? a.startedAt),
      ok: live ? undefined : (a.result?.ok ?? a.status !== 'error'),
      task,
      review,
      agent: a,
      open,
    };
    (live ? running : finished).push(entry);
  }

  needs.sort((a, b) => a.since - b.since); // longest-waiting first
  running.sort((a, b) => a.since - b.since); // longest-running first
  finished.sort((a, b) => b.since - a.since); // most recent first
  return [...needs, ...running, ...finished];
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
