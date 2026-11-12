import { theme } from '../theme.js';
import type { PrInfo, Task, WorkChanges } from '../core/types.js';

/** Human label + color for a PR's review state. */
export function reviewStatus(pr: PrInfo): { text: string; color: string } {
  if (pr.state === 'MERGED') return { text: 'merged', color: theme.merged };
  if (pr.state === 'CLOSED') return { text: 'closed', color: theme.err };
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return { text: 'approved', color: theme.ok };
    case 'CHANGES_REQUESTED':
      return { text: 'changes requested', color: theme.err };
    case 'REVIEW_REQUIRED':
      return { text: 'awaiting review', color: theme.warn };
    default:
      return { text: pr.isDraft ? 'draft — not in review' : 'no reviews yet', color: theme.dim };
  }
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Headline figure: uncached input + output, matching Claude Code's /cost. */
export function formatTokens(t: { input: number; output: number }): string {
  return fmtCount(t.input + t.output);
}

/** Full /cost-style breakdown for detail views. */
export function formatTokensFull(t: {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  const parts = [`${fmtCount(t.input)} in`, `${fmtCount(t.output)} out`];
  if (t.cacheRead) parts.push(`${fmtCount(t.cacheRead)} cache read`);
  if (t.cacheWrite) parts.push(`${fmtCount(t.cacheWrite)} cache write`);
  return parts.join(' · ');
}

/** Anything with a start (and maybe an end): tasks and reviews both qualify. */
export function formatDuration(run: { startedAt?: number; endedAt?: number }, now: number): string {
  if (!run.startedAt) return '';
  const secs = Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Pad or truncate plain text to an exact cell width (with trailing space separator built in). */
// the last char of a cell is the gutter: a value that fills its column exactly
// would otherwise run straight into the next one ("…for the digestcadence")
export function cell(text: string, w: number): string {
  return text.length >= w ? `${text.slice(0, w - 2)}… ` : text.padEnd(w);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Animation here is a function of the clock, and the clock ticks once a
 * second (app.tsx `useClock`) — deliberately slow, because a terminal without
 * synchronized output redraws the whole screen per frame.
 *
 * So a period shorter than the tick does not animate faster, it **aliases to
 * a constant**: `Math.floor(now / 500) % 2` advances by two per tick and
 * never changes parity, which is how the maintenance dot spent its life not
 * blinking. Both helpers below divide by the tick, so each one advances by
 * exactly one step per render.
 */
export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length];
}

/** Alternates every tick — for a card that is being worked on where it sits. */
export function blink(now: number): string {
  return Math.floor(now / 1000) % 2 ? '●' : '○';
}

/** An agent at work that has edited nothing for this long is worth a look — usually it is going in circles. */
export const STALL_MS = 20 * 60_000;

/** "+84 -12" — lines in and out of a task's worktree, for a card line or a table cell. */
export function changesShort(c?: WorkChanges): string {
  return c ? `+${c.added} -${c.removed}` : '';
}

/** Minutes since a working task's worktree last changed, once that is long enough to say so. */
export function stalledMinutes(task: Task, now: number): number | undefined {
  if (task.status !== 'working' || task.awaitingStart || !task.changes) return undefined;
  const idle = now - task.changes.movedAt;
  return idle >= STALL_MS ? Math.floor(idle / 60_000) : undefined;
}
