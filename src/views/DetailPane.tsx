import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens } from '../ui/format.js';
import type { Task } from '../core/types.js';

export function DetailPane(props: {
  task: Task;
  answering: boolean;
  onAnswerDone: () => void;
}) {
  const { task, answering, onAnswerDone } = props;
  const ctx = useColinear();
  const [draft, setDraft] = useState('');

  useInput(
    (input) => {
      // number keys pick a canned option while a question is pending
      if (!task.question || answering) return;
      const idx = Number.parseInt(input, 10) - 1;
      if (!Number.isNaN(idx) && task.question.options[idx]) {
        task.question.answer(task.question.options[idx]);
      }
    },
    { isActive: Boolean(task.question) && !answering && !ctx.cmdOpen },
  );

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>
        {task.issue.identifier}: {task.issue.title}{' '}
        <Text dimColor>
          {formatDuration(task, Date.now())} · {formatTokens(task.tokens)} tok · ${task.costUsd.toFixed(2)}
        </Text>
      </Text>
      {task.branch && (
        <Text dimColor>
          branch {task.branch} · worktree {task.worktree}
        </Text>
      )}
      {task.sessionId && <Text dimColor>session {task.sessionId}</Text>}

      {task.verdict && (
        <Text>
          verdict <Text bold>{task.verdict.verdict}</Text>: {task.verdict.reason.slice(0, 200)}
          {task.verdict.verdict !== 'do' && !task.escalationCommented && (
            <Text color="yellow"> — press c to post to Linear</Text>
          )}
          {task.escalationCommented && <Text color="green"> (posted to Linear)</Text>}
        </Text>
      )}

      {task.question && (
        <Box flexDirection="column">
          <Text color="magenta" bold>
            ? {task.question.text}
          </Text>
          {task.question.options.map((opt, i) => (
            <Text key={opt} color="magenta">
              {'  '}{i + 1}. {opt}
            </Text>
          ))}
          {answering ? (
            <Box>
              <Text color="magenta">answer: </Text>
              <TextInput
                value={draft}
                onChange={setDraft}
                onSubmit={(value) => {
                  if (!value.trim()) return;
                  task.question?.answer(value.trim());
                  setDraft('');
                  onAnswerDone();
                }}
              />
            </Box>
          ) : (
            <Text dimColor>press 1-{task.question.options.length || 1} to pick, or a to type an answer</Text>
          )}
        </Box>
      )}

      {task.subtasks.length > 0 && (
        <Box flexDirection="column">
          {/* capped: an unbounded checklist squeezes the board above off-screen */}
          {task.subtasks.slice(0, 5).map((s) => (
            <Text key={s.text} color={s.done ? 'green' : undefined} dimColor={s.done}>
              {s.done ? '☑' : '☐'} {s.text.slice(0, 100)}
            </Text>
          ))}
          {task.subtasks.length > 5 && (
            <Text dimColor>… {task.subtasks.length - 5} more (enter for task view)</Text>
          )}
        </Box>
      )}

      {task.checks.map((c) => (
        <Text key={c.name} color={c.ok ? 'green' : 'red'}>
          {c.ok ? '✔' : '✖'} {c.name}
          {!c.ok && <Text dimColor> — {lastLines(c.output, 2)}</Text>}
        </Text>
      ))}

      {task.prs.map((pr) => (
        <Text key={pr.number} color="cyan">
          #{pr.number} {pr.title.slice(0, 60)} [{pr.isDraft ? 'draft' : pr.state.toLowerCase()}, {pr.checksStatus}]{' '}
          {pr.baseRefName !== '' && <Text dimColor>← {pr.baseRefName}</Text>}
        </Text>
      ))}

      <Text dimColor>── activity ──</Text>
      {task.activity.slice(-5).map((line, i) => (
        <Text key={`${i}-${line.slice(0, 10)}`} dimColor>
          {line.slice(0, 140)}
        </Text>
      ))}
    </Box>
  );
}

function lastLines(text: string, n: number): string {
  return text.trim().split('\n').slice(-n).join(' | ').slice(0, 160);
}
