import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useReviews, useTasks } from '../core/hooks.js';
import { rowSpend, totalSpend } from '../core/spend.js';
import type { Review, Task } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { cell, formatDuration, formatTokens } from '../ui/format.js';
import { REVIEW_COLORS, STATUS_COLORS, theme } from '../theme.js';

type SortKey = 'cost' | 'tokens' | 'recent';

const SORTS: SortKey[] = ['cost', 'tokens', 'recent'];

/**
 * Spend per run, live. Bars are relative to the priciest visible row, and
 * tasks and reviews share the chart — both spend agent sessions.
 */
interface SpendRow {
  key: string;
  label: string;
  title: string;
  /**
   * Undefined when nothing in this row carried a price, which is not the same
   * as zero. A runtime that reports no price must not be summed as free, or
   * the total reads as authoritative while understating what was spent.
   */
  costUsd?: number;
  /** sessions on this row whose runtime priced nothing */
  unpriced: number;
  /** the models that actually ran it — more than one once models vary by kind */
  models: string[];
  tokens: { input: number; output: number };
  color: string;
  startedAt?: number;
  endedAt?: number;
  /** navigation target, when the row has a view of its own */
  taskId?: string;
}

const taskRow = (t: Task): SpendRow => ({
  key: t.issue.id,
  label: t.issue.identifier,
  title: t.issue.title,
  ...rowSpend(t.spend, t.costUsd),
  tokens: t.tokens,
  color: STATUS_COLORS[t.status] ?? theme.dim,
  startedAt: t.startedAt,
  endedAt: t.endedAt,
  taskId: t.issue.identifier,
});

const reviewRow = (r: Review): SpendRow => ({
  key: r.id,
  label: `${r.repository.split('/')[1] ?? r.repository}#${r.number}`,
  title: r.title,
  ...rowSpend(r.spend, r.costUsd),
  tokens: r.tokens,
  color: REVIEW_COLORS[r.status] ?? theme.dim,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
});

export function CostsView(_props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const reviews = useReviews();
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [sort, setSort] = useState<SortKey>('cost');
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => {
    const tokens = (r: SpendRow) => r.tokens.input + r.tokens.output;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = [...tasks.map(taskRow), ...reviews.map(reviewRow)];
    const matched = all.filter((r) => {
      const hay = `${r.label} ${r.title}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
    return matched.sort((a, b) => {
      if (sort === 'tokens') return tokens(b) - tokens(a);
      if (sort === 'recent') return (b.startedAt ?? 0) - (a.startedAt ?? 0);
      // an unpriced row sorts as cheapest rather than as free: it has no
      // claim on the top of a cost sort, and none to being called $0 either
      return (b.costUsd ?? -1) - (a.costUsd ?? -1);
    });
  }, [tasks, reviews, query, sort]);

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  // the filter bar owns the keyboard while it's open
  useEffect(() => ctx.setCapture(filtering), [filtering]);
  useEffect(() => () => ctx.setCapture(false), []);
  useEffect(() => {
    ctx.setEscHandler(query ? () => (setQuery(''), true) : null);
    return () => ctx.setEscHandler(null);
  }, [query]);

  useInput(
    (input, key) => {
      if (input === '/') setFiltering(true);
      if (key.upArrow || input === 'i') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'k') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === 's') setSort((s) => SORTS[(SORTS.indexOf(s) + 1) % SORTS.length]);
      if (key.return && rows[cursor]?.taskId) ctx.navigate('task', rows[cursor].taskId!);
    },
    { isActive: !filtering && !ctx.cmdOpen },
  );

  const { costUsd: total, unpriced } = totalSpend(rows);
  const max = rows.reduce((n, r) => Math.max(n, r.costUsd ?? 0), 0);
  // label + bar + figures share the row: everything but the bar is fixed-width
  const barWidth = Math.max(10, Math.min(40, ctx.size.columns - 72));
  const visible = Math.max(3, ctx.size.rows - 11);
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          cost per run{' '}
        </Text>
        <Text dimColor>
          {rows.length} run{rows.length === 1 ? '' : 's'} · ${total.toFixed(2)} total
          {unpriced ? ` · ${unpriced} session${unpriced === 1 ? '' : 's'} unpriced` : ''} · sort:{' '}
        </Text>
        <Text color={theme.accent}>{sort}</Text>
        {query ? <Text color={theme.accent}> /{query}</Text> : null}
      </Box>
      <Text dimColor>what this would cost on the API — subscription runs are not billed per token</Text>
      {filtering && (
        <CommandBar
          prefix="/"
          initial={query}
          onChange={setQuery}
          onSubmit={() => setFiltering(false)}
          onCancel={() => {
            setQuery('');
            setFiltering(false);
          }}
        />
      )}
      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        {window.map((row, i) => {
          const selected = start + i === cursor;
          // any real spend gets at least one block, or cheap runs read as $0
          const cost = row.costUsd ?? 0;
          const scaled = max > 0 ? Math.round((cost / max) * barWidth) : 0;
          const filled = cost > 0 ? Math.max(1, scaled) : 0;
          return (
            <Text key={row.key} wrap="truncate" inverse={selected}>
              <Text bold={selected}>{cell(row.label, 20)}</Text>
              {/* plain on the cursor row: inverse turns a cell colour into a
                  background, which breaks the row into mismatched blocks */}
              <Text color={selected ? undefined : row.color}>
                {'█'.repeat(filled)}
                <Text dimColor={!selected}>{'·'.repeat(barWidth - filled)}</Text>
              </Text>
              {/* "--" rather than $0.00: a runtime that priced nothing did not
                  cost nothing, and the two must not read the same */}
              <Text bold>{` ${row.costUsd === undefined ? '--' : `$${row.costUsd.toFixed(2)}`}`.padStart(9)}</Text>
              <Text dimColor>
                {' '}
                {formatTokens(row.tokens).padStart(6)} tok {(formatDuration(row, ctx.now) || '--:--').padStart(6)}{' '}
                {row.models.length ? `${row.models.join('+')} · ` : ''}
                {row.title.slice(0, 40)}
              </Text>
            </Text>
          );
        })}
        {!rows.length && <Text dimColor>Nothing matches.</Text>}
      </Box>
    </Box>
  );
}

export const costsKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row'],
  ['/', 'filter'],
  ['s', 'sort'],
  ['enter', 'task detail'],
];
