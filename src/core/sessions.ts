import { log } from './log.js';

/**
 * Every agent colinear has running, in one place.
 *
 * Sessions are started from four different places — the dispatcher, the
 * reviewer, a project plan, a one-off draft — and each of them tracked its own
 * in its own shape, so the only way to see "what is running right now" was to
 * visit three views and know that drafting sessions appeared in none of them.
 *
 * Registration happens inside `runSession`, which every agent goes through, so
 * a new caller cannot forget to be visible.
 */
export type AgentKind =
  | 'triage'
  | 'work'
  | 'maintenance'
  | 'coordinator'
  | 'review'
  | 'plan'
  | 'draft-issue'
  | 'draft-project';

export interface AgentSession {
  /** registry id, not the Claude session id */
  id: string;
  kind: AgentKind;
  /** what it is working on, in the operator's words: CLO-203, cloud#902, a project name */
  label: string;
  /** why it is running — the answer to "what started this" */
  origin: string;
  cwd: string;
  model?: string;
  /** Claude's own id, once it reports one: what `claude --resume` takes */
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error';
  /** the last thing it said it was doing */
  activity?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  /** filled in when the work this session was for has an outcome */
  result?: { ok: boolean; summary: string; url?: string };
}

/** How long a finished session stays listed, so you can see what just happened. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;
const MAX_FINISHED = 40;

let counter = 0;
const sessions = new Map<string, AgentSession>();

export function startSession(info: {
  kind: AgentKind;
  label: string;
  origin: string;
  cwd: string;
  model?: string;
}): string {
  const id = `a${++counter}`;
  sessions.set(id, {
    id,
    ...info,
    startedAt: Date.now(),
    status: 'running',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
  });
  return id;
}

export function updateSession(id: string, patch: Partial<AgentSession>): void {
  const existing = sessions.get(id);
  if (!existing) return;
  sessions.set(id, { ...existing, ...patch });
}

export function endSession(id: string, status: 'done' | 'error', extra?: Partial<AgentSession>): void {
  updateSession(id, { status, endedAt: Date.now(), ...extra });
  prune();
}

/** Newest first, running before finished — the order you want to read it in. */
export function listSessions(): AgentSession[] {
  prune();
  return [...sessions.values()].sort((a, b) => {
    if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
    return b.startedAt - a.startedAt;
  });
}

/**
 * Finished sessions age out; running ones never do. A session that has been
 * "running" for hours is a fact worth seeing, not something to tidy away.
 */
function prune(): void {
  const finished = [...sessions.values()]
    .filter((s) => s.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [i, session] of finished.entries()) {
    if (i >= MAX_FINISHED || (session.endedAt ?? 0) < cutoff) sessions.delete(session.id);
  }
}

/** Everything running, for a shutdown that wants to say what it interrupted. */
export function runningCount(): number {
  let n = 0;
  for (const s of sessions.values()) if (s.status === 'running') n++;
  return n;
}

export function logRunning(): void {
  for (const s of sessions.values()) {
    if (s.status === 'running') log(`still running at shutdown: ${s.kind} ${s.label} (${s.origin})`);
  }
}
