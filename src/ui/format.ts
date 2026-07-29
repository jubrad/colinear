import type { PrInfo, Task } from '../core/types.js';

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

export function formatTokens(t: { input: number; output: number }): string {
  const total = t.input + t.output;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}k`;
  return String(total);
}

export function formatDuration(task: Task, now: number): string {
  if (!task.startedAt) return '';
  const secs = Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000);
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
