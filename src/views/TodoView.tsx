import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTodo, useReviews, useTasks } from '../core/hooks.js';
import { openUrl } from '../core/open.js';
import { store } from '../core/store.js';
import { handledReason } from '../core/todo.js';
import type { TodoFacts, TodoItem, TodoUrgency } from '../core/types.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { cell, spinner } from '../ui/format.js';
import { theme } from '../theme.js';

const URGENCY_COLOR: Record<TodoUrgency, string> = {
  now: theme.err,
  today: theme.warn,
  week: theme.info,
  later: theme.dim,
};

const KIND_COLOR: Record<TodoItem['kind'], string> = {
  review: theme.accent,
  task: theme.key,
  issue: theme.ok,
  milestone: theme.info,
  project: theme.info,
};

/** rows the selected entry's detail takes under the list: rule, title, why ×2, facts, link */
const DETAIL_ROWS = 6;

function ago(then: number | undefined, now: number): string {
  if (!then) return 'never';
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const PRIORITY: Record<number, string> = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low' };

/** The facts that ranked it, as one readable line — what the agent was shown. */
function factLine(f: TodoFacts): string {
  const bits: string[] = [];
  if (f.priority !== undefined && PRIORITY[f.priority]) bits.push(`P${f.priority} ${PRIORITY[f.priority]}`);
  if (f.projectPriority && PRIORITY[f.projectPriority]) bits.push(`project P${f.projectPriority}`);
  if (f.due) {
    const days = f.daysToDue;
    const rel = days === undefined ? '' : days < 0 ? ` (${-days}d over)` : days === 0 ? ' (today)' : ` (${days}d)`;
    bits.push(`due ${f.due}${rel}${f.dueFrom && f.dueFrom !== 'issue' ? ` via ${f.dueFrom}` : ''}`);
  }
  if (f.project && f.dueFrom !== 'project') bits.push(f.milestone ? `${f.project} · ${f.milestone}` : f.project);
  if (f.waitingHours !== undefined) bits.push(`waiting ${Math.round(f.waitingHours)}h of ${f.slaHours}h`);
  if (f.stale) bits.push('stale');
  if (f.author) bits.push(`by ${f.author}`);
  if (f.size) bits.push(f.size);
  if (f.via === 'team') bits.push('via team');
  if (f.status) bits.push(f.status);
  if (f.state && !f.status) bits.push(f.state);
  if (f.openIssues) bits.push(`${f.openIssues} open issues`);
  if (f.progress !== undefined) bits.push(`${Math.round(f.progress * 100)}% done`);
  return bits.join(' · ');
}

/**
 * A ref cut to fit its column without losing what identifies it: in
 * "a-very-long-repository-name#123" the number is the part that
 * matters, so the repo name gives way first.
 */
function fitRef(ref: string, width: number): string {
  const room = width - 1; // the column's gutter
  if (ref.length <= room) return ref;
  const hash = ref.lastIndexOf('#');
  if (hash <= 0) return ref;
  const tail = ref.slice(hash);
  const head = Math.max(1, room - tail.length - 1);
  return `${ref.slice(0, head)}…${tail}`;
}

/** Split text into at most `rows` lines of `width`, the last one ellipsed. */
function wrapTo(text: string, width: number, rows: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > rows) {
    const kept = lines.slice(0, rows);
    kept[rows - 1] = `${kept[rows - 1].slice(0, Math.max(0, width - 1))}…`;
    return kept;
  }
  return lines;
}

/**
 * What to do next, in order.
 *
 * Reviews, tasks waiting on you, your issues, milestones and projects you lead,
 * all reduced to one shape by the daemon and ranked there — first by
 * colinear's own scoring, then by an agent weighing review SLA, deadlines and
 * priority under a policy you can replace (`todo.prompt`). This view only
 * reads the result; `r` asks for a new one.
 *
 * The list is a snapshot, but working down it ticks things off: each row is
 * checked against the live store by the same rule that listed it, so a posted
 * review or an answered question reads as handled without a refresh.
 */
export function TodoView(_props: { param?: string }) {
  const ctx = useColinear();
  const todo = useTodo();
  // subscribed so handled-ness recomputes as tasks and reviews move
  const tasks = useTasks();
  const reviews = useReviews();
  const [cursor, setCursor] = useState(0);
  const [hideHandled, setHideHandled] = useState(false);

  // nothing yet: build colinear's own order, which costs no tokens — the
  // agent pass is always the operator's call
  const enabled = ctx.cfg.todo.enabled;
  useEffect(() => {
    if (enabled && !store.todo) ctx.dispatcher.refreshTodo(false);
  }, []);

  const busy = todo?.status === 'gathering' || todo?.status === 'ranking';

  const rows = useMemo(() => {
    const all = (todo?.items ?? []).map((item) => ({
      item,
      handled: handledReason(
        item,
        { task: (id) => store.get(id), review: (id) => store.getReview(id), tasks: () => store.list() },
        ctx.cfg.todo,
        ctx.now,
        ctx.cfg.ciAutofix,
      ),
    }));
    return hideHandled ? all.filter((r) => !r.handled) : all;
    // ctx.now is left out on purpose: a review ticking past its SLA is the
    // next refresh's news, and recomputing every second buys nothing
  }, [todo, tasks, reviews, hideHandled]);

  useEffect(() => setCursor((c) => Math.max(0, Math.min(c, rows.length - 1))), [rows.length]);
  const selected = rows[cursor];

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(rows.length - 1, c + 1));
      if (input === 'g') setCursor(0);
      if (input === 'G') setCursor(Math.max(0, rows.length - 1));
      if (input === 'r') {
        if (busy) ctx.toast('already refreshing — x stops the ranking', 'info');
        else ctx.dispatcher.refreshTodo(true);
      }
      if (input === 'b' && !busy) ctx.dispatcher.refreshTodo(false);
      if (input === 'x' && todo?.status === 'ranking') ctx.dispatcher.cancelTodo();
      if (input === 'h') setHideHandled((h) => !h);
      if (input === 'o') {
        if (selected?.item.url) openUrl(selected.item.url);
        else ctx.toast('nothing to open in a browser for this one', 'info');
      }
      if (key.return && selected) {
        const target = selected.item.open;
        if (!target) return;
        // an issue with no task lives in the tracker; its link is the useful jump
        if (target.view === 'issues' && selected.item.url) openUrl(selected.item.url);
        else ctx.navigate(target.view, target.param);
      }
    },
    { isActive: enabled && !ctx.cmdOpen },
  );

  const { width, height } = useViewSize();
  const summaryLines = todo?.summary ? wrapTo(todo.summary, width, 2) : [];
  const statusLine = busy || todo?.error ? 1 : 0;
  // title, summary, status, gap, column header — then the detail below
  const fixed = 1 + summaryLines.length + statusLine + 1 + 1;
  const showDetail = height - fixed - DETAIL_ROWS >= 4;
  const visible = Math.max(1, height - fixed - (showDetail ? DETAIL_ROWS : 0));
  const start = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const window = rows.slice(start, start + visible);

  const refWidth = 16;
  const actionWidth = Math.max(18, Math.min(44, Math.floor((width - 4 - 7 - 10 - refWidth) * 0.4)));
  const titleWidth = Math.max(10, width - 4 - 7 - 10 - refWidth - actionWidth);
  const handledCount = (todo?.items ?? []).length - rows.length;

  const headline = !todo
    ? 'building…'
    : `${todo.items.length} of ${todo.considered} · ${
        todo.rankedBy === 'agent' ? 'ranked by the agent' : "colinear's own order"
      } ${ago(todo.generatedAt, ctx.now)}${todo.costUsd ? ` · $${todo.costUsd.toFixed(2)}` : ''}${
        hideHandled && handledCount ? ` · ${handledCount} handled hidden` : ''
      }`;

  // switched off, the view stays registered and says how to turn it on —
  // an "unknown view" would teach nothing (the same rule experiments follow)
  if (!enabled) {
    return (
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        <Text bold color={theme.header}>
          todo
        </Text>
        <Box height={1} />
        <Text>:todo is switched off in this context's config. To turn it back on, remove</Text>
        <Text color={theme.accent}>{'  "todo": false'}</Text>
        <Text>or set</Text>
        <Text color={theme.accent}>{'  "todo": { "enabled": true }'}</Text>
        <Text>— editing it from :config (e) reloads it everywhere. Nothing is gathered or ranked while it is off.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Box>
        <Text bold color={theme.header}>
          todo{' '}
        </Text>
        <Text dimColor wrap="truncate">
          {headline}
        </Text>
      </Box>
      {summaryLines.map((line, i) => (
        <Text key={`s${i}`} wrap="truncate">
          {line}
        </Text>
      ))}
      {busy ? (
        <Text color={theme.warn} wrap="truncate">
          {spinner(ctx.now)}{' '}
          {todo?.status === 'gathering'
            ? 'reading the tracker and GitHub…'
            : `the agent is ranking ${todo?.items.length ?? 0} — colinear's own order until it answers · x stops it`}
        </Text>
      ) : todo?.error ? (
        <Text color={theme.err} wrap="truncate">
          {todo.error}
        </Text>
      ) : null}
      <Box height={1} />
      <Text bold color={theme.header} wrap="truncate">
        {'  '}
        {cell('WHEN', 7)}
        {cell('KIND', 10)}
        {cell('REF', refWidth)}
        {cell('NEXT', actionWidth)}
        {cell('WHAT', titleWidth)}
      </Text>
      {window.map(({ item, handled }, i) => {
        const onCursor = start + i === cursor;
        return (
          <Text key={item.key} wrap="truncate" inverse={onCursor} dimColor={Boolean(handled) && !onCursor}>
            <Text>{handled ? '✓ ' : '  '}</Text>
            <Text color={onCursor || handled ? undefined : URGENCY_COLOR[item.urgency]}>{cell(item.urgency, 7)}</Text>
            <Text color={onCursor || handled ? undefined : KIND_COLOR[item.kind]}>{cell(item.kind, 10)}</Text>
            <Text bold={!handled}>{cell(fitRef(item.ref, refWidth), refWidth)}</Text>
            <Text>{cell(handled ?? item.action, actionWidth)}</Text>
            <Text dimColor={!onCursor}>{cell(item.title, titleWidth)}</Text>
          </Text>
        );
      })}
      {!rows.length && (
        <Text dimColor>
          {busy
            ? 'Gathering…'
            : todo
              ? hideHandled && todo.items.length
                ? 'Everything on the list is handled. h shows it again; r builds a new one.'
                : 'Nothing needs you. r asks again.'
              : 'Nothing yet.'}
        </Text>
      )}
      {showDetail && selected && (
        <Box flexDirection="column" marginTop={1} flexShrink={0}>
          <Text bold wrap="truncate">
            {selected.item.title}
          </Text>
          {wrapTo(selected.item.why, width, 2).map((line, i) => (
            <Text key={`w${i}`} wrap="truncate">
              {line}
            </Text>
          ))}
          <Text dimColor wrap="truncate">
            {factLine(selected.item.facts) || ' '}
          </Text>
          <Text dimColor wrap="truncate">
            {selected.item.url ?? ' '}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export const todoKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'row'],
  ['enter', 'open where it lives'],
  ['o', 'open in the browser'],
  ['r', 'rebuild and rank with the agent'],
  ['b', "rebuild with colinear's own order (no agent)"],
  ['x', 'stop the ranking'],
  ['h', 'hide / show what is handled'],
];
