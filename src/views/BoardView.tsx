import { Box, Text, useInput } from 'ink';
import { CommandBar, type Candidate } from '../ui/CommandBar.js';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import { store } from '../core/store.js';
import { questionSummary, type BoardLayout, type Task, type TaskStatus } from '../core/types.js';
import { useColinear } from '../ui/context.js';
import { blink, formatDuration, formatTokens, reviewStatus, spinner } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { DetailPane } from './DetailPane.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';
import { BOARD_SORT, compareTasks, matchesQuery, SORT_KEYS } from './taskLens.js';

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
 * Narrowest a card may be in the rows layout. A lane divides the width into
 * whole cards of one size — ragged widths would make the horizontal window
 * depend on which cards happen to be on screen — so this sets how many fit,
 * and the remainder is shared back out.
 */
const LANE_CARD_MIN = 26;

/** Fixed rows the task detail pane gets under either layout. */
const DETAIL_ROWS = 15;

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
  const [query, setQuery] = useState('');
  const [bar, setBar] = useState<'fuzzy' | 'sort' | null>(null);
  const [sortKey, setSortKey] = useState<string>(BOARD_SORT);
  const actions = useTaskActions();
  const layout: BoardLayout = ctx.ui.boardLayout ?? 'columns';
  const rows = layout === 'rows';

  // grid[col] = tasks in that board column, in render order
  const grid = useMemo(() => {
    // the same matcher the list view uses, so a query means one thing
    const visible = query ? tasks.filter((t) => matchesQuery(t, query)) : tasks;
    return COLUMNS.map((col) =>
      // within a column, what needs you first — or whatever `,` chose. A sort
      // orders cards inside their column; it never moves one out of it.
      visible
        .filter((t) => col.statuses.includes(t.status))
        .sort((a, b) => (sortKey === BOARD_SORT ? prRank(a) - prRank(b) : compareTasks(sortKey, a, b))),
    );
  }, [tasks, store.version, query, sortKey]);

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
      // ijkl keeps its directions in both layouts; what a direction traverses
      // is whatever the layout put on that axis. Transposed, sideways walks
      // the cards in a status and up/down changes status.
      const across = (dir: 1 | -1) => (rows ? moveRow(dir) : moveCol(dir));
      const down = (dir: 1 | -1) => (rows ? moveCol(dir) : moveRow(dir));
      if (key.leftArrow || input === 'j') across(-1);
      if (key.rightArrow || input === 'l') across(1);
      if (key.upArrow || input === 'i') down(-1);
      if (key.downArrow || input === 'k') down(1);
      if (input === 't') {
        // persisted through the daemon: the layout you chose is still there
        // after a restart, and `R` doesn't lose it either
        ctx.setUi({ boardLayout: rows ? 'columns' : 'rows' });
        return;
      }
      if (input === '/') {
        setBar('fuzzy');
        return;
      }
      if (input === ',') {
        setBar('sort');
        return;
      }
      actions.handleKey(input, key, selected);
    },
    { isActive: bar === null && !actions.busy && !ctx.cmdOpen },
  );

  useEffect(() => ctx.setCapture(bar !== null), [bar]);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

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

  // vertical budget: view inner height (app.tsx sizes the view pane to
  // rows-6-cmd, minus its own border) less the detail pane and the filter/sort
  // lines. Both layouts window to this instead of flex-squeezing.
  const filtering = Boolean(query) || sortKey !== BOARD_SORT;
  const viewInner = Math.max(8, ctx.size.rows - 6 - (ctx.cmdOpen ? 4 : 0)) - 2;
  const chrome = (selected ? DETAIL_ROWS : 0) + (filtering ? 1 : 0) + (bar ? 1 : 0);
  // columns reserve one line for the shared column-header row; a lane carries
  // its own header inside the height it reports
  const cardBudget = Math.max(4, viewInner - chrome - 1);
  const laneBudget = Math.max(4, viewInner - chrome);

  // Rows geometry. Cards are one width per lane so the horizontal window is
  // plain index arithmetic, and a lane is as tall as the tallest card it is
  // actually showing — an empty status costs its header line and nothing more.
  const perLane = Math.max(1, Math.floor((avail + 1) / (LANE_CARD_MIN + 1)));
  const laneCardW = Math.floor((avail - (perLane - 1)) / perLane);
  const laneWindows = grid.map((lane, i) =>
    windowLane(lane.length, perLane, i === pos.col ? Math.min(pos.row, Math.max(0, lane.length - 1)) : 0),
  );
  const laneHeights = grid.map((lane, i) => {
    if (!lane.length) return 1;
    const [from, to] = laneWindows[i];
    return 1 + Math.max(...lane.slice(from, to).map(cardHeight));
  });
  // whole lanes only: a lane's height is whatever its tallest card needs, and
  // Ink overflows rather than clips (see DESIGN.md), so half a lane would
  // paint over the pane below it
  const [laneStart, laneEnd] = windowColumn(laneHeights, laneBudget, pos.col);


  const shown = grid.reduce((n, col) => n + col.length, 0);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {filtering && (
        <Text wrap="truncate">
          {query ? (
            <Text color={theme.accent}>/{query} </Text>
          ) : null}
          <Text dimColor>
            {shown} of {tasks.length} cards
            {sortKey !== BOARD_SORT ? ` · sorted by ${sortKey}` : ''}
            {query ? ' · esc clears' : ''}
          </Text>
        </Text>
      )}
      {bar === 'fuzzy' && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setBar(null)}
          onCancel={() => {
            setQuery('');
            setBar(null);
          }}
        />
      )}
      {bar === 'sort' && (
        <CommandBar
          prefix="sort> "
          candidates={SORT_KEYS.map((k) => ({ label: k, value: k })) as Candidate[]}
          onSubmit={(value, top) => {
            setSortKey(top?.value ?? value ?? BOARD_SORT);
            setBar(null);
          }}
          onCancel={() => setBar(null)}
        />
      )}
      {/* overflow clip keeps tall columns from pushing card headers off-screen */}
      {rows ? (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {laneStart > 0 && (
            <Text dimColor wrap="truncate">
              ▲ {laneStart} more above
            </Text>
          )}
          {COLUMNS.slice(laneStart, laneEnd).map((col, i) => {
            const colIdx = laneStart + i;
            const laneTasks = grid[colIdx];
            const color = STATUS_COLORS[col.statuses[0]];
            const [from, to] = laneWindows[colIdx];
            // a status with nothing in it is one dim line: it still says the
            // stage exists (and that it is empty) without spending the height
            if (!laneTasks.length) {
              return (
                <Box key={col.title} flexShrink={0}>
                  <Text dimColor wrap="truncate">
                    {col.title}(0)
                  </Text>
                </Box>
              );
            }
            return (
              <Box key={col.title} flexDirection="column" flexShrink={0}>
                {/* flexShrink=0 on every line in here: under any height
                    pressure yoga pays for it by squeezing a Text to nothing,
                    and the first thing to go was the status name itself */}
                <Box flexShrink={0}>
                  <Text bold color={color} wrap="truncate">
                    {col.title}({laneTasks.length})
                    {prCounts(laneTasks)}
                    {laneTasks.length > perLane ? (
                      <Text dimColor>
                        {' '}
                        · {from + 1}-{to} of {laneTasks.length}, j/l scrolls
                      </Text>
                    ) : null}
                  </Text>
                </Box>
                <Box gap={1} flexShrink={0} overflow="hidden">
                  {laneTasks.slice(from, to).map((task) => (
                    // fixed width, own column direction: the card stretches to
                    // the lane's card width instead of hugging its own text
                    <Box key={task.issue.id} width={laneCardW} flexDirection="column" flexShrink={0}>
                      <Card
                        task={task}
                        selected={task.issue.id === selected?.issue.id}
                        color={color}
                        now={ctx.now}
                      />
                    </Box>
                  ))}
                </Box>
              </Box>
            );
          })}
          {laneEnd < COLUMNS.length && (
            <Text dimColor wrap="truncate">
              ▼ {COLUMNS.length - laneEnd} more below — i/k to scroll
            </Text>
          )}
        </Box>
      ) : (
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
              {/* the cards live in a fixed box: a single card taller than the
                  budget used to overflow the column and paint over the header
                  above it, which is Ink's behaviour for overflow, not clipping */}
              <Box flexDirection="column" height={cardBudget} flexShrink={0} overflow="hidden">
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
            </Box>
          );
        })}
      </Box>
      )}
      {selected && (
        // fixed-height pane: however tall the task detail gets, it clips here
        // instead of flex-squeezing the board columns (and their headers) away
        <Box height={DETAIL_ROWS} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} />
        </Box>
      )}
      {/* last on purpose: an absolute box is painted in tree order, so a popup
          rendered before its siblings is overdrawn by them */}
      {actions.modals}
    </Box>
  );
}

function Card(props: { task: Task; selected: boolean; color: string; now: number }) {
  const { task, selected, color, now } = props;
  const last = task.activity[task.activity.length - 1] ?? '';
  const doneCount = task.subtasks.filter((s) => s.done).length;
  // a manual dispatch sits in Working with no agent: spinning would say a
  // session is thinking when the card is in fact waiting on the operator
  const active = ACTIVE_STATUSES.includes(task.status) && !task.awaitingStart;
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
              {blink(now)}{' '}
            </Text>
          )}
          {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
        </Text>
      </Box>
      <Text dimColor wrap="truncate">
        {formatDuration(task, now) || '--:--'} · {formatTokens(task.tokens)} tok
        {task.repo ? ` · ${task.repo.name}` : ''}
      </Text>
      {task.awaitingStart && (
        <Text color={theme.key} wrap="truncate">
          ⏸ worktree ready — r starts it
        </Text>
      )}
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
          ? {questionSummary(task.question)}
        </Text>
      )}
      {task.proposals?.length ? (
        <Text color={theme.selection} wrap="truncate">
          {task.proposals.length} proposed sub-issue{task.proposals.length > 1 ? 's' : ''} — enter, P, A
        </Text>
      ) : null}
      {task.inbox?.length ? (
        <Text color={theme.key} wrap="truncate">
          {task.inbox.length} message{task.inbox.length > 1 ? 's' : ''} waiting for its next session
        </Text>
      ) : null}
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
  if (task.inbox?.length) h += 1;
  if (task.proposals?.length) h += 1;
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
 * Cards to show in one lane of the rows layout: every card is the same width,
 * so this is index arithmetic rather than a height walk. Scrolls the minimum
 * that keeps `selIdx` on screen, which leaves an unvisited lane at its start.
 */
function windowLane(count: number, fit: number, selIdx: number): [number, number] {
  if (count <= fit) return [0, count];
  const start = Math.max(0, Math.min(selIdx - fit + 1, count - fit));
  return [start, start + fit];
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

// Movement is labelled by direction, not by what it traverses: `t` swaps the
// axes, and a static key grid can't say "column" in one layout and "card" in
// the other.
export const boardKeys: Array<[string, string]> = [
  ['j/l ←→', 'across'],
  ['i/k ↑↓', 'down'],
  ['t', 'transpose'],
  ['/', 'search'],
  [',', 'sort'],
  ...TASK_ACTION_KEYS,
];
