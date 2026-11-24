import { taskLines } from './TaskTable.js';
import type { Task } from '../core/types.js';

/**
 * :tasks is the board as a list. What is pinned: board columns open with a
 * header, a parent's sub-issues sit under it whatever their own column, a
 * folded family is one line, and a sub-issue whose parent is not shown
 * stands on its own.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const task = (id: string, status: Task['status'], subs: string[] = []): Task =>
  ({ issue: { id, identifier: id, title: id }, status, subIssues: subs.map((s) => ({ id: s, identifier: s, title: s, done: false })) }) as unknown as Task;

// board order: queued, working (with the parent), pr open, done
const sorted = [task('Q', 'queued'), task('P', 'tracking', ['A', 'B']), task('A', 'working'), task('X', 'pr_open'), task('B', 'done')];
const lines = taskLines(sorted, new Set(), true);
const show = lines.map((l) => (l.kind === 'section' ? `[${l.title}]` : `${l.mark ?? ''}${l.task.issue.id}`)).join(' ');
check('columns open with a header and a family sits under its parent', show === '[Queued] Q [Working] - P └ A └ B [PR Open] X', show);
check('a column counts its top-level tasks', lines.find((l) => l.kind === 'section' && l.title === 'Working')?.kind === 'section' && (lines.find((l) => l.kind === 'section' && l.title === 'Working') as { count: number }).count === 1);

const folded = taskLines(sorted, new Set(['P']), true).map((l) => (l.kind === 'section' ? `[${l.title}]` : `${l.mark ?? ''}${l.task.issue.id}`)).join(' ');
check('a folded family is its parent line, with how many are inside', folded === '[Queued] Q [Working] +2 P [PR Open] X', folded);

const orphan = taskLines([task('A', 'working'), task('X', 'pr_open')], new Set(), true).map((l) => (l.kind === 'section' ? `[${l.title}]` : `${l.mark ?? ''}${l.task.issue.id}`)).join(' ');
check('a sub-issue whose parent is not shown stands on its own', orphan === '[Working] A [PR Open] X', orphan);

const unsorted = taskLines(sorted, new Set(), false).map((l) => (l.kind === 'section' ? `[${l.title}]` : `${l.mark ?? ''}${l.task.issue.id}`)).join(' ');
check('another sort drops the headers and keeps the families', unsorted === 'Q - P └ A └ B X', unsorted);

const nested = taskLines([task('P', 'tracking', ['M']), task('M', 'tracking', ['L']), task('L', 'working')], new Set(), false).map((l) => (l.kind === 'task' ? `${l.mark ?? ''}${l.task.issue.id}` : '')).join(' ');
check('a family within a family goes a level deeper', nested === '- P └ - M   └ L', nested);

if (failures.length) {
  console.error(`tasks: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — :tasks lists the board by column, each parent with its sub-issues under it, foldable,\n     and a sub-issue without its parent on its own');
