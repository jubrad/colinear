import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useReviews, useTasks } from '../core/hooks.js';
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
  costUsd: number;
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
  costUsd: t.costUsd,
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
  costUsd: r.costUsd,
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
      return b.costUsd - a.costUsd;
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

  const total = rows.reduce((n, r) => n + r.costUsd, 0);
  const max = rows.reduce((n, r) => Math.max(n, r.costUsd), 0);
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
          {rows.length} run{rows.length === 1 ? '' : 's'} · ${total.toFixed(2)} total · sort:{' '}
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
          const scaled = max > 0 ? Math.round((row.costUsd / max) * barWidth) : 0;
          const filled = row.costUsd > 0 ? Math.max(1, scaled) : 0;
          return (
            <Text key={row.key} wrap="truncate" inverse={selected}>
              <Text bold={selected}>{cell(row.label, 20)}</Text>
              <Text color={row.color}>
                {'█'.repeat(filled)}
                <Text dimColor>{'·'.repeat(barWidth - filled)}</Text>
              </Text>
              <Text bold> {`$${row.costUsd.toFixed(2)}`.padStart(8)}</Text>
              <Text dimColor>
                {' '}
                {formatTokens(row.tokens).padStart(6)} tok {(formatDuration(row, ctx.now) || '--:--').padStart(6)}{' '}
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
