import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import type { Task } from '../core/types.js';
import { CommandBar, fuzzyMatch, type Candidate } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens } from '../ui/format.js';
import { Table, defaultSort, type Column } from '../ui/Table.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { boardOrder, prRank, prState, PR_STATE_COLOR } from './BoardView.js';
import { DetailPane } from './DetailPane.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';

/** default order: the board read left-to-right, top-to-bottom */
const BOARD_SORT = 'board';

/** What the status column says — a maintenance session outranks the status,
 *  since "working" on an open PR means something different from a rewrite. */
function statusText(task: Task): string {
  if (task.maintenance === 'rebase') return 'rebasing';
  if (task.maintenance === 'fixci') return 'fixing ci';
  return task.status.replace('_', ' ');
}

const statusColor = (task: Task): string | undefined =>
  task.maintenance ? (task.maintenance === 'rebase' ? theme.ok : theme.warn) : STATUS_COLORS[task.status];

const ciText = (task: Task): string => task.prs[0]?.checksStatus ?? '';

const ciColor = (task: Task): string | undefined => {
  const status = ciText(task);
  if (status === 'failing') return theme.err;
  if (status === 'passing') return theme.ok;
  return status ? theme.warn : undefined;
};

const tokenTotal = (task: Task): number => task.tokens.input + task.tokens.output;

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
        sort: (a, b) => boardOrder(a) - boardOrder(b),
      },
      { key: 'title', label: 'TITLE', width: 'flex', text: (t) => t.issue.title },
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
        sort: (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
      },
      {
        key: 'tokens',
        label: 'TOKENS',
        width: 8,
        text: (t) => formatTokens(t.tokens),
        color: () => theme.dim,
        sort: (a, b) => tokenTotal(b) - tokenTotal(a),
      },
    ],
    [ctx.now],
  );

  const rows = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = tasks.filter((task) => {
      // status and PR state are in the haystack: "/needs" or "/conflict"
      // filters the list the same way the eye scans the column headers
      const haystack = [
        task.issue.identifier,
        task.issue.title,
        task.repo?.name ?? '',
        statusText(task),
        prState(task) ?? '',
        ciText(task),
      ]
        .join(' ')
        .toLowerCase();
      return tokens.every((token) => fuzzyMatch(haystack, token));
    });
    const col = sortKey === BOARD_SORT ? undefined : columns.find((c) => c.key === sortKey);
    const sorted = col
      ? [...matched].sort(defaultSort(col))
      : [...matched].sort(
          (a, b) =>
            boardOrder(a) - boardOrder(b) ||
            prRank(a) - prRank(b) ||
            a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true }),
        );
    return sortDesc ? sorted.reverse() : sorted;
  }, [tasks, query, sortKey, sortDesc, columns]);

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
      // S sorts here, as in :reviews — s stays "attach claude", as on the board
      if (input === 'S') {
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
  const showDetail = Boolean(selected) && !actions.modalOpen && budget - chrome - 15 >= 4;
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
        {query ? <Text color={theme.accent}>/{query}</Text> : <Text dimColor>/ filter · S sort</Text>}
      </Box>
      {actions.modals}
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
      {!actions.modalOpen && (
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
      )}
      {showDetail && selected && (
        <Box height={15} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} answering={actions.answering} onAnswerDone={actions.endAnswer} />
        </Box>
      )}
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
  ['S', 'sort'],
  ...TASK_ACTION_KEYS,
];
