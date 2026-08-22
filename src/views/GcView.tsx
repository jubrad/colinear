import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GcItem, GcProgress } from '../client.js';
import { findSettled } from '../core/gc.js';
import { useTasks } from '../core/hooks.js';
import { store } from '../core/store.js';
import { useColinear } from '../ui/context.js';
import { cell } from '../ui/format.js';
import { theme } from '../theme.js';

const REASON_COLOR: Record<string, string> = {
  done: theme.ok,
  cancelled: theme.dim,
  orphan: theme.warn,
  review: theme.accent,
  stale: theme.dim,
  approved: theme.ok,
  commented: theme.accent,
  changes_requested: theme.warn,
};

const formatSize = (kb: number): string =>
  kb >= 1048576 ? `${(kb / 1048576).toFixed(1)}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;

/** One line of "this is over": a worktree on disk, or a finished card on the board. */
interface Row {
  key: string;
  kind: 'tree' | 'task' | 'review';
  /** worktree rows only */
  path?: string;
  /** card rows only */
  id?: string;
  kilobytes: number;
  label: string;
  reason: string;
  ageDays: number;
  detail: string;
}

/**
 * What can go: worktree disk, and work whose outcome has landed. Everything
 * starts selected except finished work younger than the threshold — the
 * printout is the point, so nothing is removed until you say so.
 *
 * Two resources, one question. Disk is reclaimed by the daemon (git worktree
 * remove); a finished card is forgotten through the ordinary store write path,
 * which on a client forwards to the daemon like any other change.
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
  const [forgotten, setForgotten] = useState(0);
  // cards wait for the worktree pass to finish: findReclaimable reads the task
  // list to decide what a directory belongs to, and forgetting a card first
  // can turn its own worktree into something the scan no longer recognises
  const pendingForget = useRef<Row[]>([]);

  const tasks = useTasks(); // settled cards come from the mirror, not the wire
  // recomputed when the store moves or the window changes — not on the clock:
  // an age rendered to the nearest day does not need a tick
  const settled = useMemo(() => findSettled(tasks, store.listReviews(), days), [tasks, days]);

  const forget = (rows: Row[]) => {
    for (const row of rows) {
      if (!row.id) continue;
      if (row.kind === 'review') store.deleteReview(row.id);
      else store.delete(row.id);
    }
    if (rows.length) setForgotten(rows.length);
  };

  useEffect(() => ctx.onGc?.(setItems), []);
  useEffect(
    () =>
      ctx.onGcProgress?.((p) => {
        setProgress(p.finished ? undefined : p);
        if (!p.ok && p.path) setFailures((f) => (f.includes(p.path) ? f : [...f, p.path]));
        if (p.finished) {
          forget(pendingForget.current);
          pendingForget.current = [];
          // rescan when the daemon says it's done, not on a guessed timer
          ctx.dispatcher.gcScan(days);
        }
      }),
    [days],
  );
  useEffect(() => {
    setItems(undefined);
    ctx.dispatcher.gcScan(days);
  }, [days]);

  const all = useMemo<Row[]>(() => {
    const trees: Row[] = (items ?? []).map((i) => ({
      key: i.path,
      kind: 'tree',
      path: i.path,
      kilobytes: i.kilobytes,
      label: i.label,
      reason: i.reason,
      ageDays: i.ageDays,
      detail: i.path,
    }));
    const cards: Row[] = settled.map((c) => ({
      key: `card:${c.id}`,
      kind: c.kind,
      id: c.id,
      kilobytes: 0,
      label: c.label,
      reason: c.reason,
      ageDays: c.ageDays,
      detail: c.title,
    }));
    return [...trees, ...cards];
  }, [items, settled]);

  // a fresh scan replaces the selection; everything listed is fair game
  useEffect(() => {
    setPicked(new Set(all.map((r) => r.key)));
  }, [items, settled.length]);

  const chosen = useMemo(() => all.filter((r) => picked.has(r.key)), [all, picked]);
  const total = useMemo(() => chosen.reduce((n, r) => n + r.kilobytes, 0), [chosen]);
  const chosenTrees = chosen.filter((r) => r.kind === 'tree');
  const chosenCards = chosen.filter((r) => r.kind !== 'tree');
  const selected = all[Math.min(cursor, Math.max(0, all.length - 1))];

  useInput((input, key) => {
    if (confirming) {
      if (input === 'y') {
        setFailures([]);
        setForgotten(0);
        if (chosenTrees.length) {
          pendingForget.current = chosenCards;
          setProgress({ done: 0, total: chosenTrees.length, path: '', ok: true, finished: false });
          ctx.dispatcher.gcRemove(chosenTrees.map((r) => r.path as string));
        } else {
          forget(chosenCards);
        }
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
        if (!next.delete(selected.key)) next.add(selected.key);
        return next;
      });
    }
    if (input === 'a') setPicked(new Set(all.map((r) => r.key)));
    if (input === 'n') setPicked(new Set());
    if (input === '+') setDays((d) => d + 7);
    if (input === '-') setDays((d) => Math.max(0, d - 7));
    if (input === 'r') ctx.dispatcher.gcScan(days);
    if (input === 'x' && picked.size) setConfirming(true);
  });

  const width = ctx.size.columns - 6;
  const detailWidth = Math.max(20, width - 8 - 7 - 14 - 11 - 6 - 2);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        <Text bold color={theme.header}>
          reclaim{' '}
        </Text>
        <Text dimColor>
          {items ? `${all.length} listed · ` : 'scanning… '}
          {picked.size ? `${picked.size} selected · ` : ''}
        </Text>
        <Text bold color={theme.ok}>
          {formatSize(total)}
        </Text>
        {chosenCards.length > 0 && <Text dimColor> + {chosenCards.length} cards</Text>}
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
      {forgotten > 0 && !progress && (
        <Text color={theme.ok} wrap="truncate">
          ✔ forgot {forgotten} finished card{forgotten === 1 ? '' : 's'} — the tracker and GitHub are untouched
        </Text>
      )}

      <Box flexDirection="column" marginTop={1} flexGrow={1} overflow="hidden">
        <Text bold color={theme.header} wrap="truncate">
          {'  '}
          {cell('SIZE', 8)}
          {cell('KIND', 7)}
          {cell('WHAT', 14)}
          {cell('WHY', 11)}
          {cell('AGE', 6)}
          {cell('DETAIL', detailWidth)}
        </Text>
        {all.slice(0, Math.max(3, ctx.size.rows - 12)).map((row, i) => {
          // plain on the cursor row — see ui/Table: inverse over coloured cells
          // paints each colour as a background instead of one bar
          const onCursor = i === cursor;
          return (
            <Text key={row.key} wrap="truncate" inverse={onCursor}>
              <Text color={onCursor ? undefined : picked.has(row.key) ? theme.ok : theme.dim}>
                {picked.has(row.key) ? '✔ ' : '· '}
              </Text>
              <Text bold>{cell(row.kind === 'tree' ? formatSize(row.kilobytes) : '—', 8)}</Text>
              <Text dimColor={!onCursor}>{cell(row.kind, 7)}</Text>
              <Text>{cell(row.label, 14)}</Text>
              <Text color={onCursor ? undefined : REASON_COLOR[row.reason] ?? theme.dim}>
                {cell(row.reason, 11)}
              </Text>
              <Text dimColor={!onCursor}>
                {cell(`${Math.floor(row.ageDays)}d`, 6)}
                {cell(row.detail, detailWidth)}
              </Text>
            </Text>
          );
        })}
        {items && !all.length && <Text dimColor>Nothing to reclaim.</Text>}
      </Box>

      {confirming && (
        <Box borderStyle="double" borderColor={theme.err} paddingX={1}>
          <Text>
            {chosenTrees.length > 0 && `remove ${chosenTrees.length} worktrees (${formatSize(total)})`}
            {chosenTrees.length > 0 && chosenCards.length > 0 && ', '}
            {chosenCards.length > 0 && `forget ${chosenCards.length} finished cards`}?{' '}
            <Text color={theme.key}>y</Text>
            <Text dimColor>
              {' '}
              / any other key cancels — branches, commits, tracker issues and PRs all stay
            </Text>
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
