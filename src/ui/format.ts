import type { PrInfo } from '../core/types.js';

/** Human label + color for a PR's review state. */
export function reviewStatus(pr: PrInfo): { text: string; color: string } {
  if (pr.state === 'MERGED') return { text: 'merged', color: 'green' };
  if (pr.state === 'CLOSED') return { text: 'closed', color: 'red' };
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return { text: 'approved', color: 'green' };
    case 'CHANGES_REQUESTED':
      return { text: 'changes requested', color: 'red' };
    case 'REVIEW_REQUIRED':
      return { text: 'awaiting review', color: 'yellow' };
    default:
      return { text: pr.isDraft ? 'draft — not in review' : 'no reviews yet', color: 'gray' };
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
export function cell(text: string, w: number): string {
  return text.length > w ? `${text.slice(0, w - 2)}… ` : text.padEnd(w);
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinner(now: number): string {
  return SPINNER[Math.floor(now / 1000) % SPINNER.length];
}
