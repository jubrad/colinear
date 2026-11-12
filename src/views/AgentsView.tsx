import { agentFor, agentNamed } from '../core/agent.js';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { age, fleet, GROUP_LABEL, isUnread, type FleetEntry, type FleetGroup } from '../core/fleet.js';
import { useReviews, useTasks } from '../core/hooks.js';
import type { AgentSession } from '../core/sessions.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { cell, changesShort, formatTokens } from '../ui/format.js';
import { palette, theme } from '../theme.js';
import { statusText } from './taskLens.js';
import { TaskTable } from './TaskTable.js';
import { fleetGlyph } from '../ui/AgentRail.js';
import { TASK_ACTION_KEYS, useTaskActions } from './taskActions.js';

const KIND_COLOR: Record<string, string> = palette(() => ({
  question: theme.info,
  work: theme.accent,
  triage: theme.warn,
  maintenance: theme.ok,
  coordinator: theme.info,
  review: theme.accent,
  plan: theme.info,
  'draft-issue': theme.key,
  'draft-project': theme.key,
  todo: theme.info,
  job: theme.key,
  // parked: what it is waiting on
  failed: theme.err,
  escalated: theme.err,
  interrupted: theme.warn,
  conflict: theme.err,
  ci: theme.err,
  changes: theme.changes,
  closed: theme.err,
  approved: theme.ok,
  draft: theme.key,
  unstarted: theme.key,
  proposals: theme.info,
  input: theme.info,
  blocked: theme.warn,
  merged: theme.merged,
  done: theme.ok,
}));

const GROUP_COLOR: Record<FleetGroup, string> = palette(() => ({
  needs: theme.info,
  yours: theme.accent,
  running: theme.warn,
  waiting: theme.dim,
  finished: theme.dim,
}));


/** Wide enough for the list and a preview side by side. */
const SPLIT_MIN = 130;

/**
 * Every agent and every task, in the order it wants you: stopped on a
 * question, stopped on something else only you can do, at work, waiting on
 * somebody else, just done — and beside the list, the selected one in full.
 * `t` swaps the groups for every task as a sortable table (what `:tasks` was).
 *
 * Rows belong to four different things — a task, a review, a plan, a one-off
 * draft — so what you can do to one depends on what it is. `enter` goes to the
 * owner; on a task's row every board key works, so the next step is one key
 * from the line that names it.
 */
export function AgentsView(_props: { param?: string }) {
  const ctx = useColinear();
  const pane = useViewSize();
  const tasks = useTasks();
  const reviews = useReviews();
  const [agents, setAgents] = useState<AgentSession[]>([]);
  /** the cursor follows a row, not an index: rows move between groups as agents finish */
  const [cursorKey, setCursorKey] = useState<string>();
  const actions = useTaskActions();
  const table = ctx.ui.agentsLayout === 'table';
  const toggle = () => ctx.setUi({ agentsLayout: table ? 'groups' : 'table' });

  useEffect(() => ctx.onAgents?.(setAgents), []);
  // the registry isn't CDC state — it changes on its own clock inside sessions
  // that never touch the store, so this view asks rather than subscribes
  useEffect(() => {
    ctx.dispatcher.listAgents();
    const timer = setInterval(() => ctx.dispatcher.listAgents(), 1000);
    return () => clearInterval(timer);
  }, []);

  const entries = useMemo(() => fleet(tasks, reviews, agents, ctx.now), [tasks, reviews, agents, ctx.now]);
  const found = entries.findIndex((e) => e.key === cursorKey);
  const cursor = found === -1 ? 0 : found;
  const selected = entries[cursor];
  const move = (to: number) => {
    const next = entries[Math.max(0, Math.min(entries.length - 1, to))];
    if (next) setCursorKey(next.key);
  };

  useInput(
    (input, key) => {
      if (input === 't') return toggle();
      if (key.upArrow || input === 'k') move(cursor - 1);
      if (key.downArrow || input === 'j') move(cursor + 1);
      if (input === 'g') move(0);
      if (input === 'G') move(entries.length - 1);
      if (!selected) return;
      if (key.return) {
        if (selected.open) ctx.navigate(selected.open.view, selected.open.param);
        else ctx.toast('a draft has nothing to open yet — the toast lands when it is filed', 'info');
        return;
      }
      if (selected.task) return actions.handleKey(input, key, selected.task);
      // a review's question is answered from the review, where its context is
      if (input === 'a' && selected.review?.question) ctx.navigate('reviews', selected.review.id);
    },
    { isActive: !table && !actions.busy && !ctx.cmdOpen },
  );

  const wide = pane.width >= SPLIT_MIN;
  const listWidth = wide ? Math.min(90, Math.floor(pane.width * 0.5)) : pane.width;
  // the header and the gap under it; stacked, the preview takes the bottom half
  const bodyHeight = Math.max(6, pane.height - 2);
  const listHeight = wide ? bodyHeight : Math.max(4, Math.floor(bodyHeight / 2));
  // the column titles take a row of the list's
  const listRows = Math.max(1, listHeight - 1);

  // group headers are rows too: lay the list out as rows, then window it on the cursor
  const rows: Array<{ group: FleetGroup; count: number } | { entry: FleetEntry; idx: number }> = [];
  entries.forEach((e, idx) => {
    if (idx === 0 || entries[idx - 1].group !== e.group) {
      rows.push({ group: e.group, count: entries.filter((x) => x.group === e.group).length });
    }
    rows.push({ entry: e, idx });
  });
  const cursorRow = rows.findIndex((r) => 'entry' in r && r.idx === cursor);
  const top = Math.max(0, Math.min(cursorRow - Math.floor(listRows / 2), rows.length - listRows));

  const counts = (g: FleetGroup) => entries.filter((e) => e.group === g).length;

  if (table) return <TaskTable onToggle={toggle} />;

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <Text wrap="truncate">
        <Text bold color={theme.header}>
          agents{' '}
        </Text>
        {counts('needs') ? <Text color={theme.info}>{counts('needs')} asking · </Text> : null}
        {counts('yours') ? <Text color={theme.accent}>{counts('yours')} your move · </Text> : null}
        <Text dimColor>
          {counts('running')} working
          {counts('waiting') ? ` · ${counts('waiting')} waiting` : ''}
          {' · enter opens it · t table · \\ beside every view'}
        </Text>
      </Text>
      <Box height={1} />
      <Box flexDirection={wide ? 'row' : 'column'} height={bodyHeight}>
        <Box flexDirection="column" width={listWidth} flexShrink={0} height={listHeight} overflow="hidden">
          <Text bold color={theme.header} wrap="truncate">
            {'  '}
            {cell('WORKING ON', 18)}
            {cell('KIND', 13)}
            {cell('FOR', 6)}
            DOING
          </Text>
          {rows.slice(top, top + listRows).map((r) =>
            'group' in r ? (
              <Text key={`g-${r.group}`} color={GROUP_COLOR[r.group]} bold wrap="truncate">
                {GROUP_LABEL[r.group]} <Text dimColor>{r.count}</Text>
              </Text>
            ) : (
              <Row
                key={r.entry.key}
                entry={r.entry}
                onCursor={r.idx === cursor}
                unread={isUnread(r.entry, ctx.ui.seen)}
                now={ctx.now}
              />
            ),
          )}
          {!entries.length && (
            <Text dimColor wrap="wrap">
              Nothing here. Every task lands here once dispatched and stays until it is done — at work, stopped
              on you, or waiting on someone else — along with reviews, plan sessions and the drafts behind `n`.
              Press n to pick issues.
            </Text>
          )}
        </Box>
        {selected && (
          <Preview
            entry={selected}
            now={ctx.now}
            width={wide ? pane.width - listWidth - 1 : pane.width}
            height={wide ? bodyHeight : Math.max(4, bodyHeight - listHeight)}
            resume={(a) => (a.runtime ? agentNamed(ctx.cfg, a.runtime) : agentFor(ctx.cfg)).resumeHint(a.sessionId!)}
          />
        )}
      </Box>
      {/* last: an absolute box is painted in tree order */}
      {actions.modals}
    </Box>
  );
}

function Row(props: { entry: FleetEntry; onCursor: boolean; unread: boolean; now: number }) {
  const { entry, onCursor, unread, now } = props;
  const { glyph, color: glyphColor } = fleetGlyph(entry, now);
  const lineColor =
    entry.group === 'needs' ? theme.info : entry.group === 'yours' ? theme.accent : entry.ok === false ? theme.err : undefined;
  return (
    // the cursor row goes plain: inverse over coloured cells inverts into a
    // strip of mismatched blocks rather than one bar
    <Text wrap="truncate" inverse={onCursor}>
      <Text color={onCursor ? undefined : glyphColor}>{glyph} </Text>
      {/* bold: something happened here since you last opened it */}
      <Text bold={unread}>{cell(entry.label, 18)}</Text>
      <Text color={onCursor ? undefined : KIND_COLOR[entry.kind] ?? theme.dim}>{cell(entry.kind, 13)}</Text>
      <Text dimColor={!onCursor}>{cell(age(entry.since, now), 6)}</Text>
      <Text color={onCursor ? undefined : lineColor} dimColor={!onCursor && !lineColor}>
        {entry.line}
      </Text>
    </Text>
  );
}

/**
 * The selected agent in full. Sized by hand — the activity tail gets what the
 * fixed rows leave — because Ink squashes an overfull box from the top rather
 * than clipping it, and the top is the part that says what this is.
 */
function Preview(props: {
  entry: FleetEntry;
  now: number;
  width: number;
  height: number;
  resume: (a: AgentSession) => string | undefined;
}) {
  const { entry, now } = props;
  const a = entry.agent;
  const question = entry.task?.question ?? entry.review?.question;
  const activity = entry.task?.activity ?? entry.review?.activity ?? (a?.activity ? [a.activity] : []);
  const questionRows = question ? question.questions.reduce((n, q) => n + 1 + q.options.length, 0) + 1 : 0;
  const forText = a ? age(a.startedAt, a.endedAt ?? now) : undefined;
  const t = entry.task;
  const pr = t?.prs?.[0];
  const state = t
    ? [
        statusText(t),
        pr ? `PR #${pr.number}${pr.isDraft ? ' draft' : ''}` : '',
        pr?.checksStatus ? `CI ${pr.checksStatus}` : '',
        t.changes ? changesShort(t.changes) + (t.changes.uncommitted ? ` ~${t.changes.uncommitted}` : '') : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  // stopped: the line that says what happens next, where a working row has its last step
  const parked = entry.group === 'yours' || entry.group === 'waiting';
  const fixed =
    2 + // the border
    1 + // label and title
    1 + // kind, origin, clock
    (a ? 1 : 0) + // spend
    (a?.result ? 1 : 0) +
    (state ? 1 : 0) +
    (parked ? 2 : 0) +
    questionRows +
    2 + // a blank row and the activity header
    (a?.cwd ? 1 : 0) +
    (a?.sessionId ? 1 : 0) +
    1; // the keys
  const tail = activity.slice(-Math.max(0, props.height - fixed));

  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      marginLeft={props.width < 60 ? 0 : 1}
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      overflow="hidden"
    >
      <Text bold wrap="truncate">
        {entry.label}
        {entry.title ? <Text dimColor> {entry.title}</Text> : null}
      </Text>
      <Text dimColor wrap="truncate">
        <Text color={KIND_COLOR[entry.kind] ?? theme.dim}>{entry.kind}</Text>
        {a ? ` · ${a.origin}` : ''}
        {forText ? ` · ${a?.status === 'running' ? 'for' : 'ran'} ${forText}` : ''}
        {entry.group !== 'running' ? ` · ${GROUP_LABEL[entry.group]} ${age(entry.since, now)} ago` : ''}
      </Text>
      {state && (
        <Text dimColor wrap="truncate">
          {state}
        </Text>
      )}
      {parked && (
        <>
          <Text> </Text>
          <Text color={entry.group === 'yours' ? theme.accent : undefined} dimColor={entry.group === 'waiting'} bold wrap="truncate">
            {entry.group === 'yours' ? 'next: ' : 'waiting: '}
            {entry.line}
          </Text>
        </>
      )}
      {a && (
        <Text dimColor wrap="truncate">
          {a.model ? `${a.model} · ` : ''}
          {formatTokens(a.tokens)} tok · ${a.costUsd.toFixed(2)}
        </Text>
      )}
      {a?.result && (
        <Text color={a.result.ok ? theme.ok : theme.err} wrap="truncate">
          {a.result.ok ? '✓' : '✖'} {a.result.summary}
          {a.result.url ? <Text dimColor> {a.result.url}</Text> : null}
        </Text>
      )}
      {question && (
        <>
          <Text> </Text>
          {question.questions.map((q, qi) => (
            <Box key={`${qi}-${q.text.slice(0, 12)}`} flexDirection="column">
              <Text color={theme.info} bold wrap="truncate">
                ? {q.header ? `[${q.header}] ` : ''}
                {q.text}
              </Text>
              {q.options.map((opt, i) => (
                <Text key={opt.label} color={theme.info} wrap="truncate">
                  {'  '}
                  {i + 1}. {opt.label}
                  {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
                </Text>
              ))}
            </Box>
          ))}
        </>
      )}
      <Text> </Text>
      <Text bold color={theme.header} wrap="truncate">
        {activity.length ? `last ${tail.length} of ${activity.length} steps` : 'no steps yet'}
      </Text>
      {tail.map((line, i) => (
        <Text key={`${i}-${line.slice(0, 12)}`} dimColor wrap="truncate">
          {line}
        </Text>
      ))}
      <Box flexGrow={1} />
      {a?.cwd && (
        <Text dimColor wrap="truncate">
          {a.cwd}
        </Text>
      )}
      {a?.sessionId && (
        <Text dimColor wrap="truncate">
          {props.resume(a) ?? `session ${a.sessionId}`}
        </Text>
      )}
      <Text color={theme.key} wrap="truncate">
        {entry.open ? 'enter opens it' : 'a draft — nothing to open yet'}
        {entry.task ? `${entry.task.question ? ' · a answers · 1-9 picks' : ''} · every board key works here` : ''}
        {entry.review?.question ? ' · a answers, in the review' : ''}
      </Text>
    </Box>
  );
}

export const agentsKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'row'],
  ['t', 'groups ⇄ table'],
  ['/ ,', 'filter · sort (table)'],
  ...TASK_ACTION_KEYS,
];
