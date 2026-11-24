import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { store } from '../core/store.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens, formatTokensFull, stalledMinutes } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';
import type { Task } from '../core/types.js';

export function DetailPane(props: { task: Task; /** rows it may use, border included (default 15) */ height?: number }) {
  const { task } = props;
  const ctx = useColinear();

  // tracking parents roll up their sub-issues' spend
  const subTasks = (task.subIssues ?? [])
    .map((s) => store.get(s.id))
    .filter((t): t is Task => Boolean(t));
  const rolledCost = task.costUsd + subTasks.reduce((n, t) => n + t.costUsd, 0);
  const rolledTokens = subTasks.reduce(
    (acc, t) => ({
      input: acc.input + t.tokens.input,
      output: acc.output + t.tokens.output,
      cacheRead: acc.cacheRead + (t.tokens.cacheRead ?? 0),
      cacheWrite: acc.cacheWrite + (t.tokens.cacheWrite ?? 0),
    }),
    { ...task.tokens },
  );
  const isTracking = Boolean(task.subIssues?.length);

  // Every line here is exactly one row. The pane sits in a box of fixed
  // height, and Ink does not clip an overfull box: the extra lines are
  // painted over the rows above them. A multi-line verdict wrapping inside it
  // drew the activity log on top of the sub-issues. So each line truncates,
  // and the activity — the part that is live — gets whatever rows are left.
  const fixed: ReactNode[] = [];
  const line = (key: string, node: ReactNode, style: { color?: string; dimColor?: boolean } = {}) =>
    fixed.push(
      <Text key={key} wrap="truncate" color={style.color} dimColor={style.dimColor}>
        {node}
      </Text>,
    );

  line(
    'title',
    <>
      <Text bold>
        {task.issue.identifier}: {task.issue.title}
      </Text>{' '}
      <Text dimColor>
        {isTracking
          ? `${formatTokens(rolledTokens)} tok · $${rolledCost.toFixed(2)} (incl. ${task.subIssues!.length} sub-issues)`
          : `${formatDuration(task, Date.now())} · ${formatTokensFull(task.tokens)} · $${task.costUsd.toFixed(2)}`}
      </Text>
    </>,
  );
  if (isTracking) line('url', task.issue.url, { dimColor: true });
  if (task.branch) line('branch', `branch ${task.branch} · worktree ${task.worktree}`, { dimColor: true });
  if (task.sessionId) line('session', `session ${task.sessionId}`, { dimColor: true });
  if (task.changes) fixed.push(<ChangesLine key="changes" task={task} />);
  if (task.verdict) {
    // the first line of the reason: the rest is in the task view
    const reason = task.verdict.reason.split('\n').find((l) => l.trim()) ?? '';
    line(
      'verdict',
      <>
        verdict <Text bold>{task.verdict.verdict}</Text>: {reason}
        {task.verdict.verdict !== 'do' && !task.escalationCommented && <Text color={theme.warn}> — press c to post to Linear</Text>}
        {task.escalationCommented && <Text color={theme.ok}> (posted to Linear)</Text>}
      </>,
    );
  }
  if (task.question) {
    // a preview only — `a` opens the form, which has room for the full set
    task.question.questions.slice(0, 3).forEach((q, i) =>
      line(
        `q${i}`,
        <>
          ? {q.header ? `[${q.header}] ` : ''}
          {q.text}
          {q.options.length ? <Text dimColor> ({q.options.map((o) => o.label).join(' / ')})</Text> : null}
        </>,
        { color: theme.info },
      ),
    );
    line(
      'answer',
      <>
        press <Text color={theme.key}>a</Text> to answer
        {task.question.questions.length === 1 && task.question.questions[0].options.length
          ? `, or 1-${task.question.questions[0].options.length} to pick`
          : ''}
        {task.question.questions.length > 1 ? ` · ${task.question.questions.length} questions` : ''}
      </>,
      { dimColor: true },
    );
  }
  if (task.proposals?.length) {
    task.proposals.slice(0, 4).forEach((p, i) =>
      line(
        `p${i}`,
        <>
          ◌ proposed: {p.title}
          {p.repo ? <Text dimColor> [{p.repo}]</Text> : null}
        </>,
        { color: theme.selection },
      ),
    );
    line('p-how', 'enter reviews them · A creates them · D creates and starts them', { dimColor: true });
  }
  (task.inbox ?? []).slice(0, 3).forEach((m, i) => line(`in${i}`, `→ queued for the agent: ${m.replace(/\s+/g, ' ')}`, { color: theme.key }));
  if (task.subIssues?.length) {
    task.subIssues.slice(0, 5).forEach((s) => {
      const live = !s.done ? store.get(s.id) : undefined;
      line(
        `sub-${s.id}`,
        <>
          {s.done ? '☑' : '☐'} {s.identifier} {s.title}
          {live ? <Text color={STATUS_COLORS[live.status]}> ⚒ {live.status}</Text> : null}
        </>,
        s.done ? { color: theme.ok, dimColor: true } : {},
      );
    });
    if (task.subIssues.length > 5) line('sub-more', `… ${task.subIssues.length - 5} more (enter for task view)`, { dimColor: true });
  } else if (task.subtasks.length) {
    task.subtasks.slice(0, 5).forEach((s, i) => line(`st${i}`, `${s.done ? '☑' : '☐'} ${s.text}`, s.done ? { color: theme.ok, dimColor: true } : {}));
    if (task.subtasks.length > 5) line('st-more', `… ${task.subtasks.length - 5} more (enter for task view)`, { dimColor: true });
  }
  task.checks.forEach((c) =>
    line(
      `c-${c.name}`,
      <>
        {c.ok ? '✔' : '✖'} {c.name}
        {!c.ok && <Text dimColor> — {lastLines(c.output, 2)}</Text>}
      </>,
      { color: c.ok ? theme.ok : theme.err },
    ),
  );
  task.prs.forEach((pr) =>
    line(
      `pr-${pr.number}`,
      <>
        #{pr.number} {pr.title} [{pr.isDraft ? 'draft' : pr.state.toLowerCase()}, {pr.checksStatus}]{' '}
        {pr.baseRefName !== '' && <Text dimColor>← {pr.baseRefName}</Text>}
      </>,
      { color: theme.accent },
    ),
  );

  // inside the border: what is fixed first, then the activity tail in what is left
  const height = props.height ?? 15;
  const inner = Math.max(1, height - 2);
  const shown = fixed.slice(0, inner);
  const room = inner - shown.length - 1; // the activity heading takes a row
  const tail = room > 0 ? task.activity.slice(-room) : [];
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.dim} paddingX={1} height={height} overflow="hidden">
      {shown}
      {room > 0 && <Text dimColor>── activity ──</Text>}
      {tail.map((l, i) => (
        <Text key={`a${i}-${l.slice(0, 10)}`} dimColor wrap="truncate">
          {l.replace(/\s+/g, ' ')}
        </Text>
      ))}
    </Box>
  );
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join(' | ').slice(0, 160);
}

/** What the worktree has changed so far, and how long since it last did. */
function ChangesLine(props: { task: Task }) {
  const c = props.task.changes!;
  const now = Date.now();
  const stalled = stalledMinutes(props.task, now);
  const ago = Math.floor((now - c.movedAt) / 60_000);
  return (
    <Text dimColor wrap="truncate">
      changes <Text color={theme.ok}>+{c.added}</Text> <Text color={theme.err}>-{c.removed}</Text> in {c.files} file
      {c.files === 1 ? '' : 's'}
      {c.uncommitted ? <Text color={theme.warn}> · {c.uncommitted} not committed</Text> : ' · all committed'}
      {stalled !== undefined ? (
        <Text color={theme.warn}> · no edits for {stalled}m — it may be going in circles</Text>
      ) : (
        ` · last moved ${ago ? `${ago}m ago` : 'just now'}`
      )}
    </Text>
  );
}
