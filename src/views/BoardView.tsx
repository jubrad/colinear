import { Box, Text, useInput } from 'ink';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { attachSession } from '../core/attach.js';
import { useTasks } from '../core/hooks.js';
import { postComment } from '../core/linear.js';
import { store } from '../core/store.js';
import type { Task, TaskStatus } from '../core/types.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens, reviewStatus, spinner } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { DetailPane } from './DetailPane.js';

interface BoardColumn {
  title: string;
  statuses: TaskStatus[];
}

const COLUMNS: BoardColumn[] = [
  { title: 'Queued', statuses: ['queued', 'interrupted'] },
  { title: 'Triage', statuses: ['triage'] },
  { title: 'Working', statuses: ['working', 'checks'] },
  { title: 'Needs Input', statuses: ['needs_input'] },
  { title: 'PR Open', statuses: ['pr_open'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Escalated', statuses: ['escalated', 'error'] },
];

const ACTIVE_STATUSES: TaskStatus[] = ['triage', 'working', 'checks'];

export function columnTasks(tasks: Task[]): Task[] {
  return COLUMNS.flatMap((col) => tasks.filter((t) => col.statuses.includes(t.status)));
}

export function BoardView(_props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const [cursorIdx, setCursorIdx] = useState(0);
  const [answering, setAnswering] = useState(false);

  const ordered = useMemo(() => columnTasks(tasks), [tasks, store.version]);
  const selected = ordered[Math.min(cursorIdx, Math.max(0, ordered.length - 1))];

  useEffect(() => ctx.setCapture(answering), [answering]);
  useEffect(() => () => ctx.setCapture(false), []);

  useInput(
    (input, key) => {
      if (key.leftArrow || input === 'h' || key.upArrow || input === 'k') {
        setCursorIdx((i) => Math.max(0, i - 1));
      }
      if (key.rightArrow || input === 'l' || key.downArrow || input === 'j') {
        setCursorIdx((i) => Math.min(ordered.length - 1, i + 1));
      }
      if (input === 'a' && selected?.question) setAnswering(true);
      if (input === 'i') ctx.navigate('issues');
      if (key.return && selected) ctx.navigate('task', selected.issue.identifier);
      if (input === 'x' && selected) {
        if (ctx.dispatcher.cancel(selected.issue.id)) ctx.toast(`cancelling ${selected.issue.identifier}`, 'info');
      }
      if (input === 'r' && selected && ['interrupted', 'error', 'escalated'].includes(selected.status)) {
        ctx.dispatcher.resume(selected.issue.id);
        ctx.toast(`requeued ${selected.issue.identifier}`, 'ok');
      }
      if (input === 's' && selected) attachSession(selected, ctx);
      if (input === 'o' && selected?.prs[0]) {
        execFile('open', [selected.prs[0].url], () => {});
        ctx.toast(`opened #${selected.prs[0].number}`, 'info');
      }
      if (input === 'O' && selected) {
        execFile('open', [selected.issue.url], () => {});
        ctx.toast(`opened ${selected.issue.identifier} in Linear`, 'info');
      }
      if (input === 'c' && selected?.status === 'escalated' && selected.verdict && !selected.escalationCommented) {
        const v = selected.verdict;
        const body =
          v.verdict === 'too_big'
            ? `**colinear triage: too big for a single agent.**\n\n${v.reason}\n\nSuggest creating a project and splitting this up.`
            : `**colinear triage: needs more info.**\n\n${v.reason}`;
        void postComment(ctx.cfg, selected.issue.id, body)
          .then(() => {
            store.update(selected.issue.id, { escalationCommented: true });
            ctx.toast(`escalation posted to ${selected.issue.identifier}`, 'ok');
          })
          .catch(() => ctx.toast('Linear comment failed', 'err'));
      }
    },
    { isActive: !answering && !ctx.cmdOpen },
  );

  if (!tasks.length) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text dimColor>No agents dispatched yet.</Text>
        <Text dimColor>
          press <Text color={theme.key}>i</Text> to pick issues
        </Text>
      </Box>
    );
  }

  const colWidth = Math.max(18, Math.floor((ctx.size.columns - COLUMNS.length) / COLUMNS.length));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* overflow clip keeps tall columns from pushing card headers off-screen */}
      <Box gap={1} flexGrow={1} overflow="hidden">
        {COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => col.statuses.includes(t.status));
          const color = STATUS_COLORS[col.statuses[0]];
          return (
            <Box key={col.title} flexDirection="column" width={colWidth} flexShrink={0}>
              <Text bold color={color}>
                {col.title}({colTasks.length})
              </Text>
              {colTasks.map((task) => (
                <Card
                  key={task.issue.id}
                  task={task}
                  selected={task.issue.id === selected?.issue.id}
                  color={color}
                  now={ctx.now}
                />
              ))}
            </Box>
          );
        })}
      </Box>
      {selected && (
        // fixed-height pane: however tall the task detail gets, it clips here
        // instead of flex-squeezing the board columns (and their headers) away
        <Box height={15} flexShrink={0} flexDirection="column" overflow="hidden">
          <DetailPane task={selected} answering={answering} onAnswerDone={() => setAnswering(false)} />
        </Box>
      )}
    </Box>
  );
}

function Card(props: { task: Task; selected: boolean; color: string; now: number }) {
  const { task, selected, color, now } = props;
  const last = task.activity[task.activity.length - 1] ?? '';
  const doneCount = task.subtasks.filter((s) => s.done).length;
  const active = ACTIVE_STATUSES.includes(task.status);
  return (
    <Box
      flexDirection="column"
      borderStyle={selected ? 'double' : 'round'}
      borderColor={selected ? theme.borderFocus : color}
      paddingX={1}
    >
      <Text bold wrap="truncate">
        {active && <Text color={theme.warn}>{spinner(now)} </Text>}
        {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {formatDuration(task, now) || '--:--'} · {formatTokens(task.tokens)} tok
      </Text>
      {task.subtasks.length > 0 && (
        <Text wrap="truncate">
          <Text color={doneCount === task.subtasks.length ? theme.ok : theme.warn}>
            {progressBar(doneCount, task.subtasks.length)}
          </Text>{' '}
          {doneCount}/{task.subtasks.length}
        </Text>
      )}
      {task.status === 'error' && (
        <Text color={theme.err} wrap="truncate">
          ✖ {task.error}
        </Text>
      )}
      {task.question && (
        <Text color={theme.info} wrap="truncate">
          ? {task.question.text}
        </Text>
      )}
      {task.verdict && task.verdict.verdict !== 'do' && (
        <Text color={theme.err}>{task.verdict.verdict === 'too_big' ? '⛰ too big' : '？needs info'}</Text>
      )}
      {last && !task.question && (
        <Text dimColor wrap="truncate">
          {last.slice(0, 60)}
        </Text>
      )}
      {task.checks.length > 0 && (
        <Text wrap="truncate">
          {task.checks.map((c) => (
            <Text key={c.name} color={c.ok ? theme.ok : theme.err}>
              {c.ok ? '✔' : '✖'}{c.name}{' '}
            </Text>
          ))}
        </Text>
      )}
      {task.prs.map((pr) => {
        const review = reviewStatus(pr);
        return (
          <Text key={pr.number} color={theme.accent} wrap="truncate">
            #{pr.number} {pr.isDraft ? 'draft' : pr.state.toLowerCase()}{' '}
            <Text color={pr.checksStatus === 'failing' ? theme.err : pr.checksStatus === 'passing' ? theme.ok : theme.warn}>
              {pr.checksStatus}
            </Text>{' '}
            <Text color={review.color}>{review.text}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function progressBar(done: number, total: number, width = 8): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const boardKeys: Array<[string, string]> = [
  ['←→/hl', 'select card'],
  ['enter', 'task detail'],
  ['a', 'answer'],
  ['x', 'cancel'],
  ['s', 'attach'],
  ['r', 'resume'],
  ['c', 'escalate'],
  ['o', 'open PR'],
  ['O', 'open issue'],
  ['i', 'issues'],
];
