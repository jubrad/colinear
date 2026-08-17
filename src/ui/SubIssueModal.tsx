import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { Issue } from '../core/types.js';
import { theme } from '../theme.js';

export interface SubIssueRow {
  issue: Issue;
  /** why this row can't be dispatched (shown as a chip); selectable when unset */
  disabled?: 'done' | 'on board';
}

/** Checkbox picker for dispatching a parent's sub-issues. */
export function SubIssueModal(props: {
  parent: string;
  rows: SubIssueRow[];
  onSubmit: (picked: Issue[]) => void;
  onCancel: () => void;
}) {
  const { parent, rows, onSubmit, onCancel } = props;
  const selectable = useMemo(() => rows.filter((r) => !r.disabled), [rows]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectable.map((r) => r.issue.id)),
  );

  useInput((input, key) => {
    if (key.escape || input === 'q') onCancel();
    if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
    if (input === ' ') {
      const row = rows[cursor];
      if (!row || row.disabled) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.issue.id)) next.delete(row.issue.id);
        else next.add(row.issue.id);
        return next;
      });
    }
    if (input === 'a') {
      setSelected((prev) =>
        prev.size === selectable.length ? new Set() : new Set(selectable.map((r) => r.issue.id)),
      );
    }
    if (key.return) {
      const picked = selectable.filter((r) => selected.has(r.issue.id)).map((r) => r.issue);
      if (picked.length) onSubmit(picked);
      else onCancel();
    }
  });

  return (
    // the frame belongs to Popup; this is only the contents
    <Box flexDirection="column" flexShrink={0}>
      <Text bold color={theme.key}>
        sub-issues of {parent} — {selected.size}/{selectable.length} selected
      </Text>
      {rows.map((row, i) => (
        <Text key={row.issue.id} inverse={i === cursor} dimColor={Boolean(row.disabled)} wrap="truncate">
          {row.disabled ? '· ' : selected.has(row.issue.id) ? '◉ ' : '○ '}
          {row.issue.identifier.padEnd(10)}
          {row.issue.title.slice(0, 70)}
          {row.disabled ? (
            <Text color={theme.dim}> [{row.disabled}]</Text>
          ) : (
            <Text color={theme.dim}> [{row.issue.stateName}]</Text>
          )}
        </Text>
      ))}
      <Text dimColor>space: toggle · a: all/none · enter: dispatch selected · esc: cancel</Text>
    </Box>
  );
}
