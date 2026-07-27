import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { attachSession } from '../core/attach.js';
import { useTasks } from '../core/hooks.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens, reviewStatus, spinner } from '../ui/format.js';
import { STATUS_COLORS, theme } from '../theme.js';

/** k9s logs-style full-screen task detail; param = issue identifier. */
export function TaskView(props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const task = useMemo(
    () => tasks.find((t) => t.issue.identifier.toLowerCase() === props.param?.toLowerCase()),
    [tasks, props.param],
  );
  const [scroll, setScroll] = useState<number | null>(null); // null = follow tail
  const [answering, setAnswering] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => ctx.setCapture(answering), [answering]);
  useEffect(() => () => ctx.setCapture(false), []);

  const logRows = Math.max(6, ctx.size.rows - 20);
  const activity = task?.activity ?? [];
  const maxStart = Math.max(0, activity.length - logRows);
  const start = scroll === null ? maxStart : Math.min(scroll, maxStart);

  useInput(
    (input, key) => {
      if (!task) return;
      if (key.upArrow || input === 'k') setScroll((s) => Math.max(0, (s ?? maxStart) - 1));
      if (key.downArrow || input === 'j') {
        setScroll((s) => {
          const next = (s ?? maxStart) + 1;
          return next >= maxStart ? null : next;
        });
      }
      if (input === 'g') setScroll(0);
      if (input === 'G') setScroll(null);
      if (input === 'a' && task.question) setAnswering(true);
      const num = Number.parseInt(input, 10);
      if (!Number.isNaN(num) && task.question?.options[num - 1] && !answering) {
        task.question.answer(task.question.options[num - 1]);
      }
      if (input === 'x') {
        if (ctx.dispatcher.cancel(task.issue.id)) ctx.toast(`cancelling ${task.issue.identifier}`, 'info');
        else ctx.toast('no live session to cancel', 'err');
      }
      if (input === 's') attachSession(task, ctx);
      if (input === 'r') {
        ctx.dispatcher.resume(task.issue.id);
        ctx.toast(`requeued ${task.issue.identifier}`, 'ok');
      }
      if (input === 'o' && task.prs[0]) execFile('open', [task.prs[0].url], () => {});
      if (input === 'O') execFile('open', [task.issue.url], () => {});
      if (input === 'd' && task.prs[0]?.isDraft) {
        execFile('gh', ['pr', 'ready', String(task.prs[0].number)], { cwd: ctx.cfg.repo }, (err) => {
          if (err) ctx.toast(`gh pr ready failed`, 'err');
          else ctx.toast(`#${task.prs[0].number} marked ready`, 'ok');
        });
      }
    },
    { isActive: !answering },
  );

  if (!task) {
    return (
      <Box flexDirection="column">
        <Text color={theme.err}>No task for “{props.param ?? ''}”.</Text>
        <Text dimColor>usage: :task CLOUD-123 (or press enter on a board card)</Text>
      </Box>
    );
  }

  const active = ['triage', 'working', 'checks'].includes(task.status);
  const doneCount = task.subtasks.filter((s) => s.done).length;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text wrap="truncate">
        {active && <Text color={theme.warn}>{spinner(ctx.now)} </Text>}
        <Text bold color={theme.accent}>
          {task.issue.identifier}
        </Text>{' '}
        {task.issue.title}
      </Text>
      <Text wrap="truncate">
        <Text color={STATUS_COLORS[task.status]} bold>
          {task.status}
        </Text>
        <Text dimColor>
          {' '}· {formatDuration(task, ctx.now) || '--:--'} · {formatTokens(task.tokens)} tok · $
          {task.costUsd.toFixed(2)}
          {task.branch ? ` · ${task.branch}` : ''}
        </Text>
      </Text>
      {task.instructions && (
        <Text dimColor wrap="truncate">
          instructions: {task.instructions}
        </Text>
      )}
      {task.error && <Text color={theme.err}>✖ {task.error.slice(0, 200)}</Text>}
      {task.verdict && task.verdict.verdict !== 'do' && (
        <Text color={theme.err} wrap="truncate">
          {task.verdict.verdict}: {task.verdict.reason}
        </Text>
      )}

      {task.subtasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.header}>
            SUBTASKS ({doneCount}/{task.subtasks.length})
          </Text>
          {task.subtasks.slice(0, 10).map((s) => (
            <Text key={s.text} color={s.done ? theme.ok : undefined} dimColor={s.done} wrap="truncate">
              {s.done ? '☑' : '☐'} {s.text}
            </Text>
          ))}
        </Box>
      )}

      {(task.checks.length > 0 || task.prs.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          {task.checks.map((c) => (
            <Text key={c.name} color={c.ok ? theme.ok : theme.err} wrap="truncate">
              {c.ok ? '✔' : '✖'} {c.name}
              {!c.ok && <Text dimColor> — {c.output.trim().split('\n').slice(-1)[0]?.slice(0, 120)}</Text>}
            </Text>
          ))}
          {task.prs.map((pr) => {
            const review = reviewStatus(pr);
            return (
              <Box key={pr.number} flexDirection="column">
                <Text wrap="truncate">
                  <Text color={theme.accent} bold>
                    #{pr.number}
                  </Text>{' '}
                  {pr.title.slice(0, 60)} <Text dimColor>[{pr.isDraft ? 'draft' : pr.state.toLowerCase()}]</Text>{' '}
                  <Text color={pr.checksStatus === 'failing' ? theme.err : pr.checksStatus === 'passing' ? theme.ok : theme.warn}>
                    ci:{pr.checksStatus}
                  </Text>{' '}
                  <Text color={review.color}>{review.text}</Text>
                  {pr.isDraft && <Text dimColor> · d to mark ready</Text>}
                </Text>
                <Text dimColor wrap="truncate">
                  {'   '}
                  {pr.url} <Text>← {pr.baseRefName}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      {task.question && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.info} paddingX={1}>
          <Text color={theme.info} bold wrap="truncate">
            ? {task.question.text}
          </Text>
          {task.question.options.map((opt, i) => (
            <Text key={opt} color={theme.info}>
              {'  '}{i + 1}. {opt}
            </Text>
          ))}
          {answering ? (
            <Box>
              <Text color={theme.info}>answer: </Text>
              <TextInput
                value={draft}
                onChange={setDraft}
                onSubmit={(value) => {
                  if (!value.trim()) return;
                  task.question?.answer(value.trim());
                  setDraft('');
                  setAnswering(false);
                }}
              />
            </Box>
          ) : (
            <Text dimColor>1-{task.question.options.length || 1} pick · a type answer</Text>
          )}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        <Text bold color={theme.header}>
          ACTIVITY {scroll === null ? '(following)' : `(${start + 1}–${start + logRows}/${activity.length})`}
        </Text>
        {activity.slice(start, start + logRows).map((line, i) => (
          <Text key={`${start + i}`} dimColor wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export const taskKeys: Array<[string, string]> = [
  ['j/k', 'scroll log'],
  ['g/G', 'top/follow'],
  ['a', 'answer'],
  ['x', 'cancel agent'],
  ['s', 'attach terminal'],
  ['r', 'resume/retry'],
  ['d', 'PR ready'],
  ['o', 'open PR'],
  ['O', 'open issue'],
];
