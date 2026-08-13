import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import type { Task } from '../core/types.js';
import { CommandBar } from '../ui/CommandBar.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';

type SortKey = 'cost' | 'tokens' | 'recent';

const SORTS: SortKey[] = ['cost', 'tokens', 'recent'];

/** Spend per ticket, live. Bars are relative to the priciest visible task. */
export function CostsView(_props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const [query, setQuery] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [sort, setSort] = useState<SortKey>('cost');
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => {
    const tokens = (t: Task) => t.tokens.input + t.tokens.output;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = tasks.filter((t) => {
      const hay = `${t.issue.identifier} ${t.issue.title} ${t.repo?.name ?? ''} ${t.status}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
    return matched.sort((a, b) => {
      if (sort === 'tokens') return tokens(b) - tokens(a);
      if (sort === 'recent') return (b.startedAt ?? 0) - (a.startedAt ?? 0);
      return b.costUsd - a.costUsd;
    });
  }, [tasks, query, sort]);

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
      if (key.return && rows[cursor]) ctx.navigate('task', rows[cursor].issue.identifier);
    },
    { isActive: !filtering && !ctx.cmdOpen },
  );

  const total = rows.reduce((n, t) => n + t.costUsd, 0);
  const max = rows.reduce((n, t) => Math.max(n, t.costUsd), 0);
  // label + bar + figures share the row: everything but the bar is fixed-width
  const barWidth = Math.max(10, Math.min(40, ctx.size.columns - 62));
  const visible = Math.max(3, ctx.size.rows - 11);
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          cost per ticket{' '}
        </Text>
        <Text dimColor>
          {rows.length} task{rows.length === 1 ? '' : 's'} · ${total.toFixed(2)} total · sort:{' '}
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
        {window.map((task, i) => {
          const selected = start + i === cursor;
          // any real spend gets at least one block, or cheap tasks read as $0
          const scaled = max > 0 ? Math.round((task.costUsd / max) * barWidth) : 0;
          const filled = task.costUsd > 0 ? Math.max(1, scaled) : 0;
          return (
            <Text key={task.issue.id} wrap="truncate" inverse={selected}>
              <Text bold={selected}>{task.issue.identifier.padEnd(10)}</Text>
              <Text color={STATUS_COLORS[task.status] ?? theme.dim}>
                {'█'.repeat(filled)}
                <Text dimColor>{'·'.repeat(barWidth - filled)}</Text>
              </Text>
              <Text bold> {`$${task.costUsd.toFixed(2)}`.padStart(8)}</Text>
              <Text dimColor>
                {' '}
                {formatTokens(task.tokens).padStart(6)} tok {(formatDuration(task, ctx.now) || '--:--').padStart(6)}{' '}
                {task.issue.title.slice(0, 40)}
              </Text>
            </Text>
          );
        })}
        {!rows.length && <Text dimColor>No tasks match.</Text>}
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
