import { Box, Text } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useTasks } from '../core/hooks.js';
import type { DiffAgainst } from '../core/diff.js';
import type { Review } from '../core/types.js';
import { AnnotatedDiff } from '../ui/AnnotatedDiff.js';
import { useColinear, useViewSize } from '../ui/context.js';
import { theme } from '../theme.js';

/** How often a diff with an agent writing it is read again. */
const REFRESH_MS = 4_000;

const AGAINST_LABEL: Record<DiffAgainst, string> = {
  base: 'the whole branch',
  since: 'since you handed it back',
  live: 'live, uncommitted work included',
};

const EMPTY: Record<DiffAgainst, string> = {
  base: 'no diff — has the branch been fetched?',
  since: 'nothing committed since you handed it back — yet',
  live: 'nothing written yet',
};

/**
 * Read your own agent's work, before anyone else has to.
 *
 * The same annotated diff a PR review uses, pointed at a task's branch — and
 * the same document behind it, so a finding written here is a finding in every
 * sense. What changes is where it goes: `p` hands the list to the agent that
 * wrote the code rather than posting it to an author.
 *
 * Commenting waits for `pr_open`. That is the workflow it is for (draft
 * first, read it, then promote) and the only state where the diff holds still.
 * Before it, the view is a window onto the agent at work — the worktree as it
 * stands, uncommitted files marked, re-read every few seconds — and read-only.
 */
export function DiffView(props: { param?: string }) {
  const ctx = useColinear();
  const pane = useViewSize();
  const tasks = useTasks();
  /** keyed by task and what the diff is measured against: switching back is instant */
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  /** per task: files widened to the whole file, or opened from a search */
  const [expanded, setExpanded] = useState<Record<string, string[]>>({});
  /** what you picked with `w`; unset follows the task (live while it is being written) */
  const [picked, setPicked] = useState<DiffAgainst>();

  const task = useMemo(() => {
    const wanted = props.param?.trim().toLowerCase();
    if (!wanted) return undefined;
    return tasks.find((t) => t.issue.identifier.toLowerCase() === wanted || t.issue.id === props.param);
  }, [tasks, props.param]);

  // an agent is in the worktree: writing it, stopped on a question mid-change,
  // or answering your comments on an open PR
  const live = Boolean(task && (task.status === 'working' || task.status === 'needs_input' || task.maintenance));
  const readable = Boolean(task?.worktree && (task.status === 'pr_open' || live));
  const options = useMemo(() => {
    const out: DiffAgainst[] = ['base'];
    if (task?.handedBackSha) out.push('since');
    if (live) out.push('live');
    return out;
  }, [task?.handedBackSha, live]);
  const fallback: DiffAgainst = live && task?.status !== 'pr_open' ? 'live' : 'base';
  const against = picked && options.includes(picked) ? picked : fallback;
  const key = task ? `${task.issue.id}:${against}` : '';

  useEffect(() => ctx.onTaskDiff?.((id, diff, as) => setDiffs((d) => ({ ...d, [`${id}:${as ?? 'base'}`]: diff }))), []);
  useEffect(() => {
    if (task && readable && diffs[key] === undefined) ctx.dispatcher.taskDiff(task.issue.id, expanded[task.issue.id], against);
  }, [task?.issue.id, readable, against]);
  // While an agent is writing, the diff is re-read on a clock: that is the point
  // of reading it now. The view keeps the cursor on its line across each one.
  useEffect(() => {
    if (!task || !readable || !live) return;
    const timer = setInterval(() => ctx.dispatcher.taskDiff(task.issue.id, expanded[task.issue.id], against), REFRESH_MS);
    return () => clearInterval(timer);
  }, [task?.issue.id, readable, live, against, expanded[task?.issue.id ?? '']]);
  // the diff owns every key while it is up — esc and q close it, R reviews,
  // and / * search — so the app's own (q quits, R reloads, : the command bar)
  // stand down, the same as :reviews does while it is reading
  useEffect(() => {
    ctx.setCapture(readable);
    return () => ctx.setCapture(false);
  }, [readable]);

  if (!task) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.err}>no task matches “{props.param ?? ''}”</Text>
        <Text dimColor>usage: :diff CLO-203 — or press v on a task with an agent at work or a draft PR open</Text>
      </Box>
    );
  }
  if (!readable) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme.warn} wrap="truncate">
          {task.issue.identifier} is {task.status} — {task.worktree ? 'there is nothing being written to read' : 'it has no worktree yet'}
        </Text>
        <Text dimColor wrap="truncate">
          :diff reads a task while its agent is writing (live, read-only) and once its draft PR is open (to comment on).
        </Text>
      </Box>
    );
  }
  // Comments wait for the draft PR. Before it, the lines move under you: half
  // of what you wrote on would be gone by the time you handed it back. Live,
  // the same is true of an open PR the agent is revising.
  const readOnly =
    task.status !== 'pr_open'
      ? `${task.issue.identifier} is still being written — comments open once its draft PR does`
      : against === 'live'
        ? 'the live diff is still moving — w back to the branch as committed to comment'
        : undefined;
  const at = options.indexOf(against);
  const compare =
    options.length > 1
      ? { label: AGAINST_LABEL[against], next: AGAINST_LABEL[options[(at + 1) % options.length]], onNext: () => setPicked(options[(at + 1) % options.length]) }
      : undefined;

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
      diff={diffs[key]}
      width={pane.width}
      height={Math.max(12, pane.height)}
      busy={Boolean(task.reviewing)}
      // the chat here talks to the agent that wrote the code, because that is
      // the one you would tell something to
      onSend={(text) => ctx.dispatcher.message(task.issue.id, text, { wake: false })}
      onEditFinding={(file, line, comment, severity, startLine, _by, nth) =>
        ctx.dispatcher.editTaskFinding(task.issue.id, file, line, comment, severity, startLine, nth)
      }
      onExplain={(file, startLine, endLine, opts) =>
        ctx.dispatcher.explainLines(task.issue.id, file, startLine, endLine, opts)
      }
      expanded={expanded[task.issue.id]}
      onExpand={(files) => {
        setExpanded((e) => ({ ...e, [task.issue.id]: files }));
        ctx.dispatcher.taskDiff(task.issue.id, files, against);
      }}
      readOnly={readOnly}
      compare={compare}
      emptyText={EMPTY[against]}
      onSearch={(mode, query) => ctx.dispatcher.codeSearch(task.issue.id, mode, query)}
      onPost={() => {
        ctx.dispatcher.sendFindings(task.issue.id);
        ctx.toast(`${task.issue.identifier}: handing your review to the agent…`, 'info');
      }}
      onReview={task.status !== 'pr_open' ? undefined : () => {
        ctx.dispatcher.reviewTask(task.issue.id);
        ctx.toast(`${task.issue.identifier}: reading its own work…`, 'info');
      }}
      onClose={() => ctx.back()}
    />
  );
}

export const diffKeys: Array<[string, string]> = [
  ['i/k ↑↓', 'row'],
  ['j/l ←→', 'word, for *'],
  ['n/N', 'next annotation'],
  ['enter', 'read it in full'],
  ['v', 'mark a block'],
  ['e', 'comment · I annotate'],
  ['a', 'ask what it does'],
  ['/', 'search the checkout'],
  ['*', 'call sites of the word, or pick one'],
  ['x', 'whole file · back to the diff'],
  ['w', 'the branch · since your hand-back · live'],
  ['R', 'have an agent review it'],
  ['p', 'hand the comments to the agent'],
  ['tab', 'message the agent'],
];
