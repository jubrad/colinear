import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import { store } from '../core/store.js';
import type { Task, TaskStatus } from '../core/types.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens, reviewStatus, spinner } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { DetailPane } from './DetailPane.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';

interface BoardColumn {
  title: string;
  statuses: TaskStatus[];
}

const COLUMNS: BoardColumn[] = [
  // pipeline reads left-to-right; finished work parks on the right edge
  { title: 'Queued', statuses: ['queued', 'blocked', 'interrupted'] },
  { title: 'Triage', statuses: ['triage'] },
  { title: 'Working', statuses: ['working', 'checks', 'tracking'] },
  { title: 'Needs Input', statuses: ['needs_input'] },
  { title: 'PR Open', statuses: ['pr_open'] },
  { title: 'Failed', statuses: ['escalated', 'error'] },
  { title: 'Done', statuses: ['done', 'cancelled'] },
];

const ACTIVE_STATUSES: TaskStatus[] = ['triage', 'working', 'checks'];

/**
 * What a task's PR is waiting on, in the order it wants your attention:
 * approved is yours to merge, changes-requested is yours to fix, a draft is
 * yours to promote, and awaiting review is somebody else's move.
 */
const PR_STATES = ['changes', 'conflict', 'approved', 'draft', 'awaiting', 'merged', 'closed'] as const;
type PrState = (typeof PR_STATES)[number];

export const PR_STATE_COLOR: Record<PrState, string> = {
  conflict: theme.err,
  approved: theme.ok,
  merged: theme.merged,
  changes: theme.changes,
  draft: theme.dim,
  awaiting: theme.key,
  closed: theme.err,
};

export function prState(task: Task): PrState | undefined {
  const pr = task.prs[0];
  if (!pr) return undefined;
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.reviewDecision === 'APPROVED') return 'approved';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (pr.mergeable === 'CONFLICTING') return 'conflict';
  if (pr.isDraft) return 'draft';
  return 'awaiting';
}

/** PR-state order for sorting; tasks with no PR sort last. */
export const prRank = (task: Task): number => {
  const state = prState(task);
  return state ? PR_STATES.indexOf(state) : PR_STATES.length;
};

export function columnTasks(tasks: Task[]): Task[] {
  return COLUMNS.flatMap((col) => tasks.filter((t) => col.statuses.includes(t.status)));
}

/** Which board column a task belongs to — the list view's default ordering. */
export function boardOrder(task: Task): number {
  const idx = COLUMNS.findIndex((col) => col.statuses.includes(task.status));
  return idx === -1 ? COLUMNS.length : idx;
}

export function BoardView(_props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const [pos, setPos] = useState({ col: 0, row: 0 });
  const actions = useTaskActions();

  // grid[col] = tasks in that board column, in render order
  const grid = useMemo(
    () =>
      COLUMNS.map((col) =>
        // within a column, PR state orders the cards: what needs you first.
        // Columns whose tasks have no PRs keep their existing order.
        tasks.filter((t) => col.statuses.includes(t.status)).sort((a, b) => prRank(a) - prRank(b)),
      ),
    [tasks, store.version],
  );

  // keep the cursor on a real card as tasks move between columns; must
  // return the SAME object when nothing changes or this setState loops
  useEffect(() => {
    setPos((p) => {
      if (grid[p.col]?.length) {
        const row = Math.min(p.row, grid[p.col].length - 1);
        return row === p.row ? p : { col: p.col, row };
      }
      const near = grid.findIndex((g, i) => g.length && i >= p.col);
      const before = grid.map((g, i) => (g.length ? i : -1)).filter((i) => i !== -1 && i < p.col);
      const col = near !== -1 ? near : (before[before.length - 1] ?? -1);
      if (col === -1) return p.col === 0 && p.row === 0 ? p : { col: 0, row: 0 };
      return col === p.col && p.row === 0 ? p : { col, row: 0 };
    });
  }, [grid]);

  const selected = grid[pos.col]?.[Math.min(pos.row, Math.max(0, (grid[pos.col]?.length ?? 1) - 1))];

  const moveCol = (dir: 1 | -1) =>
    setPos((p) => {
      let col = p.col;
      do {
        col += dir;
      } while (col >= 0 && col < grid.length && !grid[col].length);
      if (col < 0 || col >= grid.length) return p;
      return { col, row: Math.min(p.row, grid[col].length - 1) };
    });

  const moveRow = (dir: 1 | -1) =>
    setPos((p) => ({
      col: p.col,
      row: Math.max(0, Math.min((grid[p.col]?.length ?? 1) - 1, p.row + dir)),
    }));

  useInput(
    (input, key) => {
      // ijkl: i/k walk cards in a column, j/l jump columns (arrows too)
      if (key.leftArrow || input === 'j') moveCol(-1);
      if (key.rightArrow || input === 'l') moveCol(1);
      if (key.upArrow || input === 'i') moveRow(-1);
      if (key.downArrow || input === 'k') moveRow(1);
      // the same board of tasks, searchable and sortable
      if (input === '/') ctx.navigate('tasks');
      actions.handleKey(input, key, selected);
    },
    { isActive: !actions.busy && !ctx.cmdOpen },
  );

  if (!tasks.length) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text dimColor>No agents dispatched yet.</Text>
        <Text dimColor>
          press <Text color={theme.key}>n</Text> to pick issues
        </Text>
      </Box>
    );
  }

  // available width: terminal minus root padding (2), view border (2) + its
  // padding (2), then the inter-column gaps — the old math used the raw
  // terminal width and clipped the last (Failed) column's right border
  const avail = ctx.size.columns - 6;
  const colWidth = Math.max(16, Math.floor((avail - (COLUMNS.length - 1)) / COLUMNS.length));

  // vertical budget for cards: view inner height (app.tsx sizes the view pane
  // to rows-6-cmd, minus its own border) less the detail pane and the column
  // header line. Columns window their cards to this instead of flex-squeezing.
  const viewInner = Math.max(8, ctx.size.rows - 6 - (ctx.cmdOpen ? 4 : 0)) - 2;
  const cardBudget = Math.max(4, viewInner - (selected ? 15 : 0) - 1);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {actions.modals}
      {/* overflow clip keeps tall columns from pushing card headers off-screen */}
      <Box gap={1} flexGrow={1} overflow="hidden">
        {COLUMNS.map((col, colIdx) => {
          const colTasks = grid[colIdx];
          const color = STATUS_COLORS[col.statuses[0]];
          // window the column to the height budget, scrolled so the cursor's
          // card stays visible — cards never flex-shrink into unreadability
          const selIdx = colIdx === pos.col ? Math.min(pos.row, Math.max(0, colTasks.length - 1)) : 0;
          const [start, end] = windowColumn(colTasks.map(cardHeight), cardBudget, selIdx);
          return (
            <Box key={col.title} flexDirection="column" width={colWidth} flexShrink={0}>
              <Text bold color={color} wrap="truncate">
                {col.title}({colTasks.length})
                {prCounts(colTasks)}
              </Text>
              {start > 0 && (
                <Text dimColor wrap="truncate">
                  ▲ {start} more above
                </Text>
              )}
              {colTasks.slice(start, end).map((task) => (
                <Card
                  key={task.issue.id}
                  task={task}
                  selected={task.issue.id === selected?.issue.id}
                  color={color}
                  now={ctx.now}
                />
              ))}
              {end < colTasks.length && (
                <Text dimColor wrap="truncate">
                  ▼ {colTasks.length - end} more — i/k to scroll
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      {selected && !actions.modalOpen && (
        // fixed-height pane: however tall the task detail gets, it clips here
        // instead of flex-squeezing the board columns (and their headers) away.
        // hidden while a modal is open so the modal always has vertical room
        <Box height={15} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} answering={actions.answering} onAnswerDone={actions.endAnswer} />
        </Box>
      )}
    </Box>
  );
}

function Card(props: { task: Task; selected: boolean; color: string; now: number }) {
  const { task, selected, color, now } = props;
  const last = task.activity[task.activity.length - 1] ?? '';
  const doneCount = task.subtasks.filter((s) => s.done).length;
  const active = ACTIVE_STATUSES.includes(task.status);
  if (task.status === 'done' || task.status === 'cancelled') {
    // settled work — id, title, and how it finished is the whole story
    const merged = task.prs.find((pr) => pr.state === 'MERGED');
    const cancelled = task.status === 'cancelled';
    return (
      <Box
        flexDirection="column"
        flexShrink={0}
        borderStyle={selected ? 'double' : 'round'}
        borderColor={selected ? theme.borderFocus : STATUS_COLORS[task.status]}
        paddingX={1}
      >
        <Text bold wrap="truncate" dimColor={cancelled}>
          {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
        </Text>
        {cancelled ? (
          <Text dimColor wrap="truncate">
            ⊘ cancelled in Linear
          </Text>
        ) : (
          <Text color={merged ? theme.merged : theme.ok} wrap="truncate">
            {merged ? `✓ merged #${merged.number}` : '✓ marked done'}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Box
      flexDirection="column"
      // windowing handles overflow; shrinking would compress cards instead
      flexShrink={0}
      borderStyle={selected ? 'double' : 'round'}
      // per-status border, not per-column: tracking parents in the Working
      // column read differently from cards with a live agent
      borderColor={selected ? theme.borderFocus : (STATUS_COLORS[task.status] ?? color)}
      paddingX={1}
    >
      {/* fixed two-line wrapped title: every card shows the same amount of
          text instead of a one-line truncate that hides most of it */}
      <Box height={2} overflow="hidden">
        <Text bold wrap="wrap">
          {active && <Text color={theme.warn}>{spinner(now)} </Text>}
          {task.maintenance && (
            // blinks where the card already is: an open PR being repaired,
            // not a task back in development
            <Text color={task.maintenance === 'rebase' ? theme.ok : theme.warn}>
              {Math.floor(now / 500) % 2 ? '●' : '○'}{' '}
            </Text>
          )}
          {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
        </Text>
      </Box>
      <Text dimColor wrap="truncate">
        {formatDuration(task, now) || '--:--'} · {formatTokens(task.tokens)} tok
        {task.repo ? ` · ${task.repo.name}` : ''}
      </Text>
      {task.subIssues?.length ? (
        // tracking parent: sub-issue progress is the story, not PRs
        <>
          <Text wrap="truncate">
            <Text color={STATUS_COLORS.tracking}>
              {progressBar(task.subIssues.filter((s) => s.done).length, task.subIssues.length)}
            </Text>{' '}
            {task.subIssues.filter((s) => s.done).length}/{task.subIssues.length} sub-issues
          </Text>
          {task.subIssues.slice(0, 3).map((s) => (
            <Text key={s.id} dimColor wrap="truncate">
              {s.done ? '✓' : '·'} {s.identifier} {s.title}
            </Text>
          ))}
        </>
      ) : null}
      {task.subtasks.length > 0 && !task.subIssues?.length && (
        <Text wrap="truncate">
          <Text color={doneCount === task.subtasks.length ? theme.ok : theme.warn}>
            {progressBar(doneCount, task.subtasks.length)}
          </Text>{' '}
          {doneCount}/{task.subtasks.length}
        </Text>
      )}
      {task.status === 'error' && (
        <Text color={theme.err} wrap="truncate">
          ✖ {task.error}
        </Text>
      )}
      {task.question && (
        <Text color={theme.info} wrap="truncate">
          ? {task.question.text}
        </Text>
      )}
      {task.blockedBy?.length ? (
        // a forced task keeps its blockers as merge-order: still worth seeing
        <Text color={task.status === 'blocked' ? STATUS_COLORS.blocked : theme.warn} wrap="truncate">
          ⛓ {task.status === 'blocked' ? '' : 'merge after '}
          {task.blockedBy.map((b) => b.identifier).join(', ')}
          {task.status === 'blocked' ? <Text dimColor> · f starts anyway</Text> : null}
        </Text>
      ) : null}
      {task.verdict && task.verdict.verdict !== 'do' && !task.subIssues?.length && (
        <Text color={theme.err} wrap="truncate">
          {task.verdict.verdict === 'too_big' ? '⛰ too big' : '? needs info'}
          {task.verdict.subtasks?.length ? (
            <Text color={theme.info}> — enter: review {task.verdict.subtasks.length}-issue plan</Text>
          ) : null}
        </Text>
      )}
      {last && !task.question && (
        <Text dimColor wrap="truncate">
          {last.slice(0, 60)}
        </Text>
      )}
      {task.checks.length > 0 && (
        <Text wrap="truncate">
          {task.checks.map((c) => (
            <Text key={c.name} color={c.ok ? theme.ok : theme.err}>
              {c.ok ? '✔' : '✖'}{c.name}{' '}
            </Text>
          ))}
        </Text>
      )}
      {(task.subIssues?.length ? [] : task.prs).map((pr) => {
        const review = reviewStatus(pr);
        return (
          <Text key={pr.number} color={theme.accent} wrap="truncate">
            #{pr.number} {pr.isDraft ? 'draft' : pr.state.toLowerCase()}{' '}
            <Text color={pr.checksStatus === 'failing' ? theme.err : pr.checksStatus === 'passing' ? theme.ok : theme.warn}>
              {pr.checksStatus}
            </Text>{' '}
            <Text color={review.color}>{review.text}</Text>
          </Text>
        );
      })}
    </Box>
  );
}


/** Rendered height of a card in terminal rows — must mirror Card's branches. */
function cardHeight(task: Task): number {
  if (task.status === 'done' || task.status === 'cancelled') return 4; // border 2 + title 1 + outcome 1
  let h = 5; // border 2 + title 2 + duration/tokens 1
  if (task.subIssues?.length) h += 1 + Math.min(3, task.subIssues.length);
  else if (task.subtasks.length > 0) h += 1;
  if (task.status === 'error') h += 1;
  if (task.question) h += 1;
  if (task.status === 'blocked' && task.blockedBy) h += 1;
  if (task.verdict && task.verdict.verdict !== 'do' && !task.subIssues?.length) h += 1;
  if (task.activity.length && !task.question) h += 1;
  if (task.checks.length > 0) h += 1;
  if (!task.subIssues?.length) h += task.prs.length;
  return h;
}

/**
 * Slice of cards to render within `budget` rows, scrolled just far enough
 * that card `selIdx` is fully visible. Returns [start, end) indices.
 */
function windowColumn(heights: number[], budget: number, selIdx: number): [number, number] {
  const endFor = (s: number): number => {
    let used = s > 0 ? 1 : 0; // "▲ N more above" row
    let e = s;
    while (e < heights.length) {
      // reserve the "▼ N more" row unless this card is the last one
      const reserve = e < heights.length - 1 ? 1 : 0;
      if (used + heights[e] > budget - reserve && e > s) break;
      used += heights[e];
      e++;
    }
    return e;
  };
  let start = 0;
  let end = endFor(0);
  while (selIdx >= end && start < selIdx) {
    start++;
    end = endFor(start);
  }
  return [start, end];
}

/**
 * Counts per PR state for a column header, coloured — approved / changes /
 * draft / awaiting / closed, in the order they want your attention.
 */
function prCounts(tasks: Task[]) {
  const counts = new Map<PrState, number>();
  for (const task of tasks) {
    const state = prState(task);
    if (state) counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const present = PR_STATES.filter((state) => counts.get(state));
  if (!present.length) return null;
  return (
    <Text>
      {' '}
      {present.map((state, i) => (
        <Text key={state}>
          {i > 0 ? <Text dimColor>-</Text> : null}
          <Text color={PR_STATE_COLOR[state]}>{counts.get(state)}</Text>
        </Text>
      ))}
    </Text>
  );
}

function progressBar(done: number, total: number, width = 8): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const boardKeys: Array<[string, string]> = [
  ['j/l ←→', 'column'],
  ['i/k ↑↓', 'card'],
  ...TASK_ACTION_KEYS,
  ['S', 'shell'],
  ['/', 'search (list)'],
];
