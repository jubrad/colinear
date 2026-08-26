import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import type { Review } from '../core/types.js';
import { AnnotatedDiff } from '../ui/AnnotatedDiff.js';
import { useColinear } from '../ui/context.js';
import { theme } from '../theme.js';

/**
 * Read your own agent's work, before anyone else has to.
 *
 * The same annotated diff a PR review uses, pointed at a task's branch — and
 * the same document behind it, so a finding written here is a finding in every
 * sense. What changes is where it goes: `p` hands the list to the agent that
 * wrote the code rather than posting it to an author.
 *
 * Offered only on `pr_open`. That is the workflow it is for (draft first, read
 * it, then promote) and the only state where the diff holds still: the work is
 * committed and nothing is running.
 */
export function DiffView(props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const [diffs, setDiffs] = useState<Record<string, string>>({});

  const task = useMemo(() => {
    const wanted = props.param?.trim().toLowerCase();
    if (!wanted) return undefined;
    return tasks.find((t) => t.issue.identifier.toLowerCase() === wanted || t.issue.id === props.param);
  }, [tasks, props.param]);

  useEffect(() => ctx.onTaskDiff?.((id, diff) => setDiffs((d) => ({ ...d, [id]: diff }))), []);
  useEffect(() => {
    if (task && !diffs[task.issue.id]) ctx.dispatcher.taskDiff(task.issue.id);
  }, [task?.issue.id]);

  if (!task) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.err}>no task matches “{props.param ?? ''}”</Text>
        <Text dimColor>usage: :diff CLO-203 — or press v on a task whose draft PR is open</Text>
      </Box>
    );
  }
  if (task.status !== 'pr_open') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.warn} wrap="truncate">
          {task.issue.identifier} is {task.status} — reading it is offered once its draft PR is open
        </Text>
        <Text dimColor wrap="truncate">
          Until then the branch is still moving underneath you: the agent is writing, and half of
          what you read would be gone by the time you commented on it.
        </Text>
      </Box>
    );
  }

  /**
   * The annotated diff speaks Review, and everything it reads — findings,
   * chat, worktree, title — a task has too. Adapting here rather than
   * teaching the component about two entities keeps one renderer for one job.
   */
  const asReview = {
    id: task.issue.id,
    number: task.prs[0]?.number ?? 0,
    repository: task.repo?.name ?? task.issue.identifier,
    title: task.issue.title,
    findings: task.findings,
    chat: [],
    worktree: task.worktree,
    reviewedSha: task.reviewedSha,
    status: task.reviewing ? 'reviewing' : 'ready',
  } as unknown as Review;

  return (
    <AnnotatedDiff
      review={asReview}
      diff={diffs[task.issue.id]}
      width={ctx.size.columns - 4}
      height={Math.max(12, ctx.size.rows - 6)}
      now={ctx.now}
      busy={Boolean(task.reviewing)}
      // the chat here talks to the agent that wrote the code, because that is
      // the one you would tell something to
      onSend={(text) => ctx.dispatcher.message(task.issue.id, text, { wake: false })}
      onEditFinding={(file, line, comment, severity, startLine) =>
        ctx.dispatcher.editTaskFinding(task.issue.id, file, line, comment, severity, startLine)
      }
      onExplain={(file, startLine, endLine) =>
        ctx.dispatcher.explainLines(task.issue.id, file, startLine, endLine)
      }
      onPost={() => {
        ctx.dispatcher.sendFindings(task.issue.id);
        ctx.toast(`${task.issue.identifier}: handing your review to the agent…`, 'info');
      }}
      onReview={() => {
        ctx.dispatcher.reviewTask(task.issue.id);
        ctx.toast(`${task.issue.identifier}: reading its own work…`, 'info');
      }}
      onClose={() => ctx.back()}
    />
  );
}

export const diffKeys: Array<[string, string]> = [
  ['j/k ↑↓', 'row'],
  ['n/N', 'next annotation'],
  ['enter', 'read it in full'],
  ['v', 'mark a block'],
  ['e', 'comment · i annotate'],
  ['a', 'ask what it does'],
  ['R', 'have an agent review it'],
  ['p', 'hand the comments to the agent'],
  ['tab', 'message the agent'],
];
