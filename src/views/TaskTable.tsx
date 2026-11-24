import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import { taskIsStale } from '../core/staleness.js';
import type { Task } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { SortBar } from '../ui/SortBar.js';
import { useColinear } from '../ui/context.js';
import { changesShort, formatDuration, formatTokens, stalledMinutes } from '../ui/format.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { useHeldIndex } from '../ui/held.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { boardOrder, COLUMNS, prRank, prState, PR_STATE_COLOR } from './BoardView.js';
import {
  BOARD_SORT,
  ciColor,
  ciText,
  compareTasks,
  matchesQuery,
  statusColor,
  statusText,
  tokenTotal,
} from './taskLens.js';
import { DetailPane } from './DetailPane.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';

/**
 * `:agents` as a table (`t`): every task, searchable and sortable — the
 * board's data without the board's geometry, for when there are more cards
 * than a column can show, and the columns the grouped list has no room for.
 * The actions are the board's, key for key (see taskActions).
 */
/** `:tasks` — the board as a list; `t` goes to :agents, the same work grouped by whose move it is. */
export function TasksView(_props: { param?: string }) {
  const ctx = useColinear();
  return <TaskTable onToggle={() => ctx.navigate('agents')} />;
}

export const tasksKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row · g/G top and bottom'],
  ['z', 'fold or open a family: a parent and its sub-issues'],
  ['/ ,', 'filter · sort'],
  ['h', 'show tasks quiet past hideStaleDays'],
  ['t', ':agents — grouped by whose move it is'],
  ...TASK_ACTION_KEYS,
];

export function TaskTable(props: { onToggle: () => void }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const actions = useTaskActions();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState('');
  const [bar, setBar] = useState<'fuzzy' | 'sort' | null>(null);
  const [sortKey, setSortKey] = useState(BOARD_SORT);
  const [sortDesc, setSortDesc] = useState(false);
  /** `h`: tasks hidden for going quiet (hideStaleDays.tasks) back in the table */
  const [showStale, setShowStale] = useState(false);
  const staleDays = ctx.cfg.hideStaleDays.tasks;
  // quiet is measured in days: an hourly clock keeps the table from re-sorting every tick
  const staleNow = Math.floor(ctx.now / 3_600_000) * 3_600_000;

  // the family mark for each task's title, from the lines drawn
  const marksRef = useRef(new Map<string, string>());
  const marks = marksRef.current;
  const columns = useMemo<Array<Column<Task>>>(
    () => [
      { key: 'issue', label: 'ISSUE', width: 11, text: (t) => t.issue.identifier },
      {
        key: 'status',
        label: 'STATUS',
        width: 12,
        text: statusText,
        color: statusColor,
        sort: (a, b) => compareTasks('status', a, b),
      },
      // capped: past ~50 chars the title is just pushing the columns that say
      // what the task is *doing* off to the right edge
      { key: 'title', label: 'TITLE', width: 'flex', max: 60, text: (t) => `${marks.get(t.issue.id) ?? ''}${t.issue.title}` },
      { key: 'repo', label: 'REPO', width: 10, text: (t) => t.repo?.name ?? '', color: () => theme.dim },
      {
        key: 'pr',
        label: 'PR',
        width: 16,
        text: (t) => (t.prs[0] ? `#${t.prs[0].number} ${prState(t) ?? ''}` : ''),
        render: (t, w) => <PrCell task={t} width={w} />,
        // the board's order: what wants you first, tasks with no PR last
        sort: (a, b) => prRank(a) - prRank(b),
      },
      { key: 'ci', label: 'CI', width: 9, text: ciText, color: ciColor },
      {
        key: 'time',
        label: 'TIME',
        width: 7,
        text: (t) => formatDuration(t, ctx.now),
        color: () => theme.dim,
        sort: (a, b) => compareTasks('time', a, b),
      },
      {
        key: 'changes',
        label: 'CHANGE',
        width: 13,
        // lines in and out, and a ~ for files not committed yet
        text: (t) => (t.changes ? `${changesShort(t.changes)}${t.changes.uncommitted ? ` ~${t.changes.uncommitted}` : ''}` : ''),
        color: (t) => (stalledMinutes(t, ctx.now) !== undefined ? theme.warn : theme.dim),
        sort: (a, b) => changeSize(b) - changeSize(a),
      },
      {
        key: 'tokens',
        label: 'TOKENS',
        width: 8,
        text: (t) => formatTokens(t.tokens),
        color: () => theme.dim,
        sort: (a, b) => compareTasks('tokens', a, b),
      },
    ],
    [ctx.now],
  );

  const staleCount = useMemo(() => tasks.filter((t) => taskIsStale(t, staleDays, staleNow)).length, [tasks, staleDays, staleNow]);
  /** families folded to their parent's row (`z`) */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const shownTasks = useMemo(() => {
    const queried = query ? tasks.filter((task) => matchesQuery(task, query)) : tasks;
    const matched = showStale ? queried : queried.filter((t) => !taskIsStale(t, staleDays, staleNow));
    const sorted = [...matched].sort((a, b) => compareTasks(sortKey, a, b));
    return sortDesc ? sorted.reverse() : sorted;
  }, [tasks, query, sortKey, sortDesc, showStale, staleDays, staleNow]);
  /**
   * The board as a list: in board order, a header line per board column,
   * and a parent's sub-issues under it — joined with `└`, a level deeper per
   * generation — wherever the sort put the parent, the way :reviews draws a
   * PR stack. Another sort drops the column headers and keeps the families.
   */
  const rows = useMemo(
    () => taskLines(shownTasks, collapsed, sortKey === BOARD_SORT && !sortDesc),
    [shownTasks, collapsed, sortKey, sortDesc],
  );
  const toggleFamily = (parentId: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(parentId)) next.delete(parentId);
      else next.add(parentId);
      return next;
    });
  // the cursor stays on its task as the list re-sorts under it
  const at = useHeldIndex(rows, cursor, setCursor, lineKey);
  /** the next task line from `from` in `dir`, stepping over section headers */
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < rows.length; i += dir) if (rows[i].kind === 'task') return i;
    return from;
  };
  useEffect(() => {
    // never rest on a header: the first task line below it, or above
    if (rows[at]?.kind === 'section') setCursor(step(at, 1) !== at ? step(at, 1) : step(at, -1));
  }, [rows, at]);

  useEffect(() => ctx.setCapture(bar !== null || actions.busy), [bar, actions.busy]);
  useEffect(() => () => ctx.setCapture(false), []);

  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  marks.clear();
  for (const l of rows) if (l.kind === 'task' && l.mark) marks.set(l.task.issue.id, l.mark);
  // the task columns, read through each line (a header line draws itself whole)
  const lineColumns: Array<Column<TaskLine>> = columns.map((c) => ({
    ...c,
    text: (l) => (l.kind === 'task' ? c.text(l.task) : ''),
    color: c.color ? (l) => (l.kind === 'task' ? c.color!(l.task) : undefined) : undefined,
    render: c.render ? (l, w) => (l.kind === 'task' ? c.render!(l.task, w) : '') : undefined,
    sort: undefined,
  }));
  const atLine = rows[Math.min(at, Math.max(0, rows.length - 1))];
  const selected = atLine?.kind === 'task' ? atLine.task : undefined;

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'i') setCursor(step(at, -1));
      if (key.downArrow || input === 'k') setCursor(step(at, 1));
      if (input === 'g') setCursor(step(-1, 1));
      if (input === 'G') setCursor(step(rows.length, -1));
      if (input === 't') return props.onToggle();
      // a family folds to its parent's row and back, from the parent or any of its sub-issues
      if (input === 'z' && atLine?.kind === 'task') {
        const parentId = atLine.family ? atLine.task.issue.id : atLine.parentId;
        if (parentId) {
          if (!collapsed.has(parentId) && !atLine.family) setCursor(rows.findIndex((l) => l.kind === 'task' && l.task.issue.id === parentId));
          toggleFamily(parentId);
        }
        return;
      }
      if (input === 'h') return setShowStale((v) => !v);
      if (input === '/') {
        setBar('fuzzy');
        return;
      }
      // , sorts in both views; S stays shell in both, as on the board
      if (input === ',') {
        setBar('sort');
        return;
      }
      actions.handleKey(input, key, selected);
    },
    { isActive: bar === null && !actions.busy && !ctx.cmdOpen },
  );


  // the view pane is rows-8 tall inside its border; the table costs its header
  // and count lines, and the detail pane only appears when rows are left over
  const budget = Math.max(6, ctx.size.rows - 8 - (ctx.cmdOpen ? 4 : 0));
  const chrome = 3 + (bar ? 1 : 0);
  const showDetail = Boolean(selected) && budget - chrome - 15 >= 4;
  const maxRows = Math.max(3, budget - chrome - (showDetail ? 15 : 0));

  if (!tasks.length) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text dimColor>No agents dispatched yet.</Text>
        <Text dimColor>
          press <Text color={theme.key}>n</Text> to pick issues · <Text color={theme.key}>t</Text> back to the groups
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.header}>
            tasks{' '}
          </Text>
          <Text dimColor>
            [{shownTasks.length}/{tasks.length}]
          </Text>
          {staleCount > 0 && (
            <Text color={showStale ? theme.accent : theme.dim}>
              {' '}
              {staleCount} quiet {staleDays}d+ {showStale ? 'shown (h hides)' : 'hidden (h shows)'}
            </Text>
          )}
          <Text dimColor> sorted by </Text>
          <Text color={theme.header}>
            {sortKey}
            {sortDesc ? ' ↓' : ' ↑'}
          </Text>
        </Text>
        {query ? <Text color={theme.accent}>/{query}</Text> : <Text dimColor>/ filter · , sort · z fold a family · t agents</Text>}
      </Box>
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
        <SortBar
          options={[{ key: BOARD_SORT }, ...columns.map((c) => ({ key: c.key, label: c.label.toLowerCase() }))]}
          current={sortKey}
          desc={sortDesc}
          onApply={(key, desc) => {
            setSortKey(key);
            setSortDesc(desc);
            setBar(null);
          }}
          onCancel={() => setBar(null)}
        />
      )}
      <Table
        rows={rows}
        columns={lineColumns}
        getId={lineKey}
        cursor={at}
        fullRow={(l) =>
          l.kind === 'section' ? (
            <Text>
              <Text bold color={theme.header}>
                {l.title}
              </Text>
              <Text dimColor> {l.count}</Text>
            </Text>
          ) : undefined
        }
        width={ctx.size.columns - 2}
        maxRows={maxRows}
        sortKey={sortKey === BOARD_SORT ? undefined : sortKey}
        sortDesc={sortDesc}
        emptyText="No tasks match."
      />
      {showDetail && selected && (
        <Box height={15} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} height={15} />
        </Box>
      )}
      {/* last: absolute boxes paint in tree order (see BoardView) */}
      {actions.modals}
    </Box>
  );
}

function PrCell(props: { task: Task; width: number }) {
  const { task, width } = props;
  const pr = task.prs[0];
  const state = prState(task);
  if (!pr || !state) return <Text>{' '.repeat(width)}</Text>;
  const head = `#${pr.number} `.slice(0, width);
  const tail = state.slice(0, Math.max(0, width - head.length));
  return (
    <Text>
      <Text color={theme.accent}>{head}</Text>
      <Text color={PR_STATE_COLOR[state]}>{tail}</Text>
      {' '.repeat(Math.max(0, width - head.length - tail.length))}
    </Text>
  );
}

/** Lines a task's worktree has moved, for sorting by how much it has changed. */
function changeSize(t: Task): number {
  return t.changes ? t.changes.added + t.changes.removed : -1;
}

/** A line of the list: a board column's header, or a task — a parent of a family, or one of its sub-issues. */
type TaskLine =
  | { kind: 'section'; key: string; title: string; count: number }
  | {
      kind: 'task';
      task: Task;
      /** set on a family's parent: its sub-issues are listed (or folded) under it */
      family?: { size: number; collapsed: boolean };
      /** the parent a sub-issue line is under */
      parentId?: string;
      /** what goes in front of the title: `- ` / `+ ` on a parent, `└ ` a level deeper per generation */
      mark?: string;
    };

const lineKey = (l: TaskLine) => (l.kind === 'section' ? l.key : l.task.issue.id);

/**
 * Lines for the list. A task listed in a shown parent's sub-issues is drawn
 * under that parent, in the order given; a sub-issue whose parent is not
 * shown (filtered, hidden as quiet) stands on its own. With `sections`, a
 * header line opens each board column, placed by the top-level task — a
 * family stays together under its parent's column.
 */
export function taskLines(sorted: Task[], collapsed: Set<string>, sections: boolean): TaskLine[] {
  const shown = new Map(sorted.map((t) => [t.issue.id, t]));
  const parentOf = new Map<string, string>();
  for (const t of sorted) for (const s of t.subIssues ?? []) if (shown.has(s.id) && s.id !== t.issue.id) parentOf.set(s.id, t.issue.id);
  const kids = new Map<string, Task[]>();
  for (const t of sorted) {
    const p = parentOf.get(t.issue.id);
    if (p) kids.set(p, [...(kids.get(p) ?? []), t]);
  }
  const out: TaskLine[] = [];
  const placed = new Set<string>();
  const walk = (t: Task, depth: number, parentId?: string) => {
    if (placed.has(t.issue.id)) return;
    placed.add(t.issue.id);
    const children = kids.get(t.issue.id) ?? [];
    const folded = collapsed.has(t.issue.id);
    const lead = depth ? `${'  '.repeat(depth - 1)}└ ` : '';
    out.push({
      kind: 'task',
      task: t,
      parentId,
      family: children.length ? { size: children.length, collapsed: folded } : undefined,
      mark: `${lead}${children.length ? (folded ? `+${children.length} ` : '- ') : ''}` || undefined,
    });
    if (!folded) for (const c of children) walk(c, depth + 1, t.issue.id);
    else hide(t.issue.id);
  };
  // a folded family's members are inside its parent's line, not loose at the end
  const hide = (id: string) => {
    for (const c of kids.get(id) ?? []) {
      if (placed.has(c.issue.id)) continue;
      placed.add(c.issue.id);
      hide(c.issue.id);
    }
  };
  let column = -1;
  for (const t of sorted) {
    if (parentOf.has(t.issue.id) || placed.has(t.issue.id)) continue;
    if (sections) {
      const c = boardOrder(t);
      if (c !== column) {
        column = c;
        const count = sorted.filter((x) => !parentOf.has(x.issue.id) && boardOrder(x) === c).length;
        out.push({ kind: 'section', key: `section:${c}`, title: COLUMNS[c]?.title ?? 'Other', count });
      }
    }
    walk(t, 0);
  }
  // a cycle of parents leaves some unplaced: list them where the sort put them
  for (const t of sorted) if (!placed.has(t.issue.id)) walk(t, 0);
  return out;
}
