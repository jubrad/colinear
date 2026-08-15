import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import type { GcItem, GcProgress } from '../client.js';
import { useColinear } from '../ui/context.js';
import { cell } from '../ui/format.js';
import { theme } from '../theme.js';

const REASON_COLOR: Record<string, string> = {
  done: theme.ok,
  cancelled: theme.dim,
  orphan: theme.warn,
  review: theme.accent,
};

const formatSize = (kb: number): string =>
  kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;

/**
 * Worktree disk, and what can go. Everything starts selected except finished
 * work younger than the threshold — the printout is the point, so nothing is
 * removed until you say so.
 */
export function GcView(_props: { param?: string }) {
  const ctx = useColinear();
  const [items, setItems] = useState<GcItem[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [days, setDays] = useState(ctx.cfg.worktreeRetentionDays);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<GcProgress>();
  const [failures, setFailures] = useState<string[]>([]);

  useEffect(() => ctx.onGc?.(setItems), []);
  useEffect(
    () =>
      ctx.onGcProgress?.((p) => {
        setProgress(p.finished ? undefined : p);
        if (!p.ok && p.path) setFailures((f) => (f.includes(p.path) ? f : [...f, p.path]));
        // rescan when the daemon says it's done, not on a guessed timer
        if (p.finished) ctx.dispatcher.gcScan(days);
      }),
    [days],
  );
  useEffect(() => {
    setItems(undefined);
    ctx.dispatcher.gcScan(days);
  }, [days]);

  // a fresh scan replaces the selection; everything it lists is fair game
  useEffect(() => {
    if (items) setPicked(new Set(items.map((i) => i.path)));
  }, [items]);

  const total = useMemo(
    () => (items ?? []).filter((i) => picked.has(i.path)).reduce((n, i) => n + i.kilobytes, 0),
    [items, picked],
  );
  const all = items ?? [];
  const selected = all[Math.min(cursor, Math.max(0, all.length - 1))];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y') {
        setFailures([]);
        setProgress({ done: 0, total: picked.size, path: '', ok: true, finished: false });
        ctx.dispatcher.gcRemove([...picked]);
      }
      setConfirming(false);
      return;
    }
    if (progress) return; // removal in flight: the list under you is changing
    if (key.upArrow || input === 'i') setCursor((c) => Math.max(0, c - 1));
    if (key.downArrow || input === 'k') setCursor((c) => Math.min(all.length - 1, c + 1));
    if (input === ' ' && selected) {
      setPicked((p) => {
        const next = new Set(p);
        if (!next.delete(selected.path)) next.add(selected.path);
        return next;
      });
    }
    if (input === 'a') setPicked(new Set(all.map((i) => i.path)));
    if (input === 'n') setPicked(new Set());
    if (input === '+') setDays((d) => d + 7);
    if (input === '-') setDays((d) => Math.max(0, d - 7));
    if (input === 'r') ctx.dispatcher.gcScan(days);
    if (input === 'x' && picked.size) setConfirming(true);
  });

  const width = ctx.size.columns - 6;
  const pathWidth = Math.max(20, width - 8 - 14 - 11 - 6);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          worktree disk{' '}
        </Text>
        <Text dimColor>
          {items ? `${all.length} reclaimable · ` : 'scanning… '}
          {picked.size ? `${picked.size} selected · ` : ''}
        </Text>
        <Text bold color={theme.ok}>
          {formatSize(total)}
        </Text>
        <Text dimColor> · finished work kept for {days}d (+/-)</Text>
      </Box>
      <Text dimColor>
        space picks · a all · n none · x removes · live work and reviews in play are never listed
      </Text>
      {progress && (
        <Text color={theme.warn} wrap="truncate">
          removing {progress.done}/{progress.total}
          {progress.path ? ` · ${progress.path}` : ''}
        </Text>
      )}
      {failures.length > 0 && !progress && (
        <Text color={theme.err} wrap="truncate">
          ✖ {failures.length} could not be removed — see ~/.local/state/colinear/colinear.log
        </Text>
      )}

      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        <Text bold color={theme.header} wrap="truncate">
          {'  '}
          {cell('SIZE', 8)}
          {cell('WHAT', 14)}
          {cell('WHY', 11)}
          {cell('AGE', 6)}
          {cell('WORKTREE', pathWidth)}
        </Text>
        {all.slice(0, Math.max(3, ctx.size.rows - 12)).map((item, i) => (
          <Text key={item.path} wrap="truncate" inverse={i === cursor}>
            <Text color={picked.has(item.path) ? theme.ok : theme.dim}>{picked.has(item.path) ? '✔ ' : '· '}</Text>
            <Text bold>{cell(formatSize(item.kilobytes), 8)}</Text>
            <Text>{cell(item.label, 14)}</Text>
            <Text color={REASON_COLOR[item.reason] ?? theme.dim}>{cell(item.reason, 11)}</Text>
            <Text dimColor>
              {cell(`${Math.floor(item.ageDays)}d`, 6)}
              {cell(item.path, pathWidth)}
            </Text>
          </Text>
        ))}
        {items && !all.length && <Text dimColor>Nothing to reclaim.</Text>}
      </Box>

      {confirming && (
        <Box borderStyle="double" borderColor={theme.err} paddingX={1}>
          <Text>
            remove {picked.size} worktrees, freeing {formatSize(total)}?{' '}
            <Text color={theme.key}>y</Text>
            <Text dimColor> / any other key cancels — the branches and commits stay in the repo</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}

export const gcKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row'],
  ['space', 'pick'],
  ['a/n', 'all/none'],
  ['+/-', 'keep-days'],
  ['x', 'remove'],
  ['r', 'rescan'],
];
