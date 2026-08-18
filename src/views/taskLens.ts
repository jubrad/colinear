import type { Task } from '../core/types.js';
import { fuzzyMatch } from '../ui/CommandBar.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { boardOrder, prRank, prState } from './BoardView.js';

/**
 * How a task reads and how it is found — shared by the board and the list,
 * which are two renderings of one set of tasks. A filter that matched
 * different things in each, or a status word that differed between them,
 * would make them feel like different data rather than different views.
 */

/** A maintenance session outranks the status: it says what is happening now. */
export function statusText(task: Task): string {
  if (task.maintenance === 'rebase') return 'rebasing';
  if (task.maintenance === 'fixci') return 'fixing ci';
  // a manual dispatch is in Working with nothing running: say so, or the card
  // looks like an agent that has gone quiet
  if (task.awaitingStart) return 'manual — r starts it';
  return task.status.replace('_', ' ');
}

export const statusColor = (task: Task): string | undefined =>
  task.maintenance ? (task.maintenance === 'rebase' ? theme.ok : theme.warn) : STATUS_COLORS[task.status];

export const ciText = (task: Task): string => task.prs[0]?.checksStatus ?? '';

export const ciColor = (task: Task): string | undefined => {
  const status = ciText(task);
  if (status === 'failing') return theme.err;
  if (status === 'passing') return theme.ok;
  return status ? theme.warn : undefined;
};

export const tokenTotal = (task: Task): number => task.tokens.input + task.tokens.output;

/** Everything a query can match, so `/conflict` and `/needs` both work. */
function haystack(task: Task): string {
  return [
    task.issue.identifier,
    task.issue.title,
    task.repo?.name ?? '',
    statusText(task),
    prState(task) ?? '',
    ciText(task),
  ]
    .join(' ')
    .toLowerCase();
}

export function matchesQuery(task: Task, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = haystack(task);
  return tokens.every((token) => fuzzyMatch(hay, token));
}

/** default: the board read left-to-right, then what needs you first */
export const BOARD_SORT = 'board';

export const SORT_KEYS = [BOARD_SORT, 'issue', 'status', 'title', 'repo', 'pr', 'ci', 'time', 'tokens'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/**
 * One comparator for both views. On the board it orders cards inside their
 * column, so a sort never moves a card out of the column it belongs to.
 */
export function compareTasks(key: string, a: Task, b: Task): number {
  switch (key) {
    case 'issue':
      return a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true });
    case 'status':
      return boardOrder(a) - boardOrder(b) || prRank(a) - prRank(b);
    case 'title':
      return a.issue.title.localeCompare(b.issue.title);
    case 'repo':
      return (a.repo?.name ?? '￿').localeCompare(b.repo?.name ?? '￿');
    case 'pr':
      return prRank(a) - prRank(b);
    case 'ci':
      return ciText(a).localeCompare(ciText(b));
    case 'time':
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    case 'tokens':
      return tokenTotal(b) - tokenTotal(a);
    default:
      return (
        boardOrder(a) - boardOrder(b) ||
        prRank(a) - prRank(b) ||
        a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true })
      );
  }
}
