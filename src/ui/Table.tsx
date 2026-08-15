import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { theme } from '../theme.js';
import { cell } from './format.js';

export interface Column<T> {
  key: string;
  label: string;
  /** fixed char width, or 'flex' (exactly one column should flex) */
  width: number | 'flex';
  /** cap on a flex column: past this the row ends early instead of stretching
      one field across a wide terminal while the rest sit far off to the right */
  max?: number;
  /** plain-text value: used for default rendering and sorting */
  text: (row: T) => string;
  /** optional rich cell — must render exactly `width` chars (use cell()/padding) */
  render?: (row: T, width: number) => ReactNode;
  color?: (row: T) => string | undefined;
  sort?: (a: T, b: T) => number;
}

export function defaultSort<T>(col: Column<T>): (a: T, b: T) => number {
  return col.sort ?? ((a, b) => col.text(a).localeCompare(col.text(b), undefined, { numeric: true }));
}

export function Table<T>(props: {
  rows: T[];
  columns: Array<Column<T>>;
  getId: (row: T) => string;
  cursor: number;
  selectedIds?: Set<string>;
  width: number;
  maxRows: number;
  sortKey?: string;
  sortDesc?: boolean;
  emptyText?: string;
}) {
  const { rows, columns, getId, cursor, selectedIds, width, maxRows, sortKey, sortDesc, emptyText } = props;

  const selWidth = selectedIds ? 2 : 0;
  const fixed = columns.reduce((n, c) => n + (c.width === 'flex' ? 0 : c.width), selWidth);
  const flexWidth = Math.max(16, width - fixed);
  const colWidth = (c: Column<T>) =>
    c.width === 'flex' ? Math.min(c.max ?? Number.POSITIVE_INFINITY, flexWidth) : c.width;

  if (!rows.length) return <Text dimColor>{emptyText ?? 'Nothing to show.'}</Text>;

  const windowStart = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), rows.length - maxRows));
  const visible = rows.slice(windowStart, windowStart + maxRows);
  const arrow = sortDesc ? '↓' : '↑';

  return (
    <Box flexDirection="column">
      {/* headers are underlined rather than dimmed: a dim header on a table of
          dim cells stops reading as a header at all */}
      <Text wrap="truncate">
        {selectedIds && ' '.repeat(selWidth)}
        {columns.map((c) => (
          <Text key={c.key} bold underline color={sortKey === c.key ? theme.accent : theme.header}>
            {cell(sortKey === c.key ? `${c.label}${arrow}` : c.label, colWidth(c))}
          </Text>
        ))}
      </Text>
      {visible.map((row, i) => {
        const idx = windowStart + i;
        const id = getId(row);
        return (
          <Text key={id} inverse={idx === cursor} wrap="truncate">
            {selectedIds && (
              <Text color={theme.selection}>{cell(selectedIds.has(id) ? '◉' : '○', selWidth)}</Text>
            )}
            {columns.map((c) =>
              c.render ? (
                <Text key={c.key}>{c.render(row, colWidth(c))}</Text>
              ) : (
                <Text key={c.key} color={c.color?.(row)}>
                  {cell(c.text(row), colWidth(c))}
                </Text>
              ),
            )}
          </Text>
        );
      })}
      {rows.length > maxRows && (
        <Text dimColor>
          {windowStart + 1}–{Math.min(windowStart + maxRows, rows.length)} of {rows.length}
        </Text>
      )}
    </Box>
  );
}
