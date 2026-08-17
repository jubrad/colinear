import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import type { Task } from '../core/types.js';
import { CommandBar, fuzzyMatch, type Candidate } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens } from '../ui/format.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { prRank, prState, PR_STATE_COLOR } from './BoardView.js';
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
 * Every task as one searchable, sortable table — the board's data without the
 * board's geometry, for when there are more cards than a column can show. The
 * actions are the board's, key for key (see taskActions).
 */
export function TasksView(props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const actions = useTaskActions();
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState(props.param ?? '');
  const [bar, setBar] = useState<'fuzzy' | 'sort' | null>(null);
  const [sortKey, setSortKey] = useState(BOARD_SORT);
  const [sortDesc, setSortDesc] = useState(false);

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
      { key: 'title', label: 'TITLE', width: 'flex', max: 50, text: (t) => t.issue.title },
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

  const rows = useMemo(() => {
    const matched = query ? tasks.filter((task) => matchesQuery(task, query)) : tasks;
    const sorted = [...matched].sort((a, b) => compareTasks(sortKey, a, b));
    return sortDesc ? sorted.reverse() : sorted;
  }, [tasks, query, sortKey, sortDesc]);

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);

  useEffect(() => ctx.setCapture(bar !== null || actions.busy), [bar, actions.busy]);
  useEffect(() => () => ctx.setCapture(false), []);

  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  const selected = rows[Math.min(cursor, rows.length - 1)];

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === 'g') setCursor(0);
      if (input === 'G') setCursor(Math.max(0, rows.length - 1));
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

  const sortCandidates = useMemo<Candidate[]>(
    () => [
      { label: `${BOARD_SORT} — board order (column, then what needs you)`, value: BOARD_SORT },
      ...columns.map((c) => ({ label: c.key, value: c.key })),
    ],
    [columns],
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
          press <Text color={theme.key}>n</Text> to pick issues
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.accent}>
            tasks
          </Text>
          <Text dimColor>
            [{rows.length}/{tasks.length}]
          </Text>
          <Text dimColor> sorted by </Text>
          <Text color={theme.header}>
            {sortKey}
            {sortDesc ? ' ↓' : ' ↑'}
          </Text>
        </Text>
        {query ? <Text color={theme.accent}>/{query}</Text> : <Text dimColor>/ filter · , sort</Text>}
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
        <CommandBar
          prefix="sort> "
          candidates={sortCandidates}
          onSubmit={(value, top) => {
            const pick = top?.value ?? value;
            if (pick) {
              if (pick === sortKey) setSortDesc((d) => !d);
              else {
                setSortKey(pick);
                setSortDesc(false);
              }
            }
            setBar(null);
          }}
          onCancel={() => setBar(null)}
        />
      )}
      <Table
        rows={rows}
        columns={columns}
        getId={(t) => t.issue.id}
        cursor={cursor}
        width={ctx.size.columns - 2}
        maxRows={maxRows}
        sortKey={sortKey === BOARD_SORT ? undefined : sortKey}
        sortDesc={sortDesc}
        emptyText="No tasks match."
      />
      {showDetail && selected && (
        <Box height={15} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} />
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

export const tasksKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'move'],
  ['/', 'filter'],
  [',', 'sort'],
  ...TASK_ACTION_KEYS,
];
