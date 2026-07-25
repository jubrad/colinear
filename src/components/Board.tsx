import { Box, Text } from 'ink';
import type { Task, TaskStatus } from '../types.js';

interface Column {
  title: string;
  statuses: TaskStatus[];
  color: string;
}

const COLUMNS: Column[] = [
  { title: 'Queued', statuses: ['queued'], color: 'gray' },
  { title: 'Triage', statuses: ['triage'], color: 'blue' },
  { title: 'Working', statuses: ['working', 'checks'], color: 'yellow' },
  { title: 'Needs Input', statuses: ['needs_input'], color: 'magenta' },
  { title: 'PR Open', statuses: ['pr_open'], color: 'cyan' },
  { title: 'Done', statuses: ['done'], color: 'green' },
  { title: 'Escalated', statuses: ['escalated', 'error'], color: 'red' },
];

export function columnTasks(tasks: Task[]): Task[] {
  // flattened in column order — the selection index walks this list
  return COLUMNS.flatMap((col) => tasks.filter((t) => col.statuses.includes(t.status)));
}

export function formatTokens(t: { input: number; output: number }): string {
  const total = t.input + t.output;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`;
  if (total >= 1_000) return `${Math.round(total / 1_000)}k`;
  return String(total);
}

export function formatDuration(task: Task, now: number): string {
  if (!task.startedAt) return '';
  const secs = Math.floor(((task.endedAt ?? now) - task.startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function Board(props: { tasks: Task[]; selectedId?: string; width: number; now: number }) {
  const { tasks, selectedId, width, now } = props;
  const colWidth = Math.max(18, Math.floor(width / COLUMNS.length) - 1);
  return (
    <Box gap={1} flexGrow={1}>
      {COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => col.statuses.includes(t.status));
        return (
          <Box key={col.title} flexDirection="column" width={colWidth} flexShrink={0}>
            <Text bold color={col.color}>
              {col.title} ({colTasks.length})
            </Text>
            {colTasks.map((task) => (
              <Card
                key={task.issue.id}
                task={task}
                selected={task.issue.id === selectedId}
                color={col.color}
                now={now}
              />
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

function Card(props: { task: Task; selected: boolean; color: string; now: number }) {
  const { task, selected, color, now } = props;
  const inner = Math.max(12, 24);
  const last = task.activity[task.activity.length - 1] ?? '';
  const doneCount = task.subtasks.filter((s) => s.done).length;
  return (
    <Box
      flexDirection="column"
      borderStyle={selected ? 'double' : 'round'}
      borderColor={selected ? 'white' : color}
      paddingX={1}
    >
      <Text bold wrap="truncate">
        {task.issue.identifier} <Text dimColor>{task.issue.title}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {formatDuration(task, now) || '--:--'} · {formatTokens(task.tokens)} tok
      </Text>
      {task.subtasks.length > 0 && (
        <Text wrap="truncate">
          <Text color={doneCount === task.subtasks.length ? 'green' : 'yellow'}>
            {progressBar(doneCount, task.subtasks.length)}
          </Text>{' '}
          {doneCount}/{task.subtasks.length}
        </Text>
      )}
      {task.status === 'error' && (
        <Text color="red" wrap="truncate">
          ✖ {task.error}
        </Text>
      )}
      {task.question && (
        <Text color="magenta" wrap="truncate">
          ? {task.question.text}
        </Text>
      )}
      {task.verdict && task.verdict.verdict !== 'do' && (
        <Text color="red">{task.verdict.verdict === 'too_big' ? '⛰ too big' : '？needs info'}</Text>
      )}
      {last && !task.question && (
        <Text dimColor wrap="truncate">
          {last.slice(0, inner * 2)}
        </Text>
      )}
      {task.checks.length > 0 && (
        <Text wrap="truncate">
          {task.checks.map((c) => (
            <Text key={c.name} color={c.ok ? 'green' : 'red'}>
              {c.ok ? '✔' : '✖'}{c.name}{' '}
            </Text>
          ))}
        </Text>
      )}
      {task.prs.map((pr) => (
        <Text key={pr.number} color="cyan" wrap="truncate">
          #{pr.number} {pr.isDraft ? 'draft' : pr.state.toLowerCase()}{' '}
          <Text color={pr.checksStatus === 'failing' ? 'red' : pr.checksStatus === 'passing' ? 'green' : 'yellow'}>
            {pr.checksStatus}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

function progressBar(done: number, total: number, width = 8): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
