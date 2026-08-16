import { Box, Text, useInput } from 'ink';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { attachSession, attachShell, setPendingAction } from '../core/attach.js';
import { createBlocksRelation, createIssue, fetchIssuesByIds } from '../core/linear.js';
import { useTasks } from '../core/hooks.js';
import { store } from '../core/store.js';
import { AnswerModal } from '../ui/AnswerModal.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokensFull, reviewStatus, spinner } from '../ui/format.js';
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
  // a parked too_big verdict is exactly why you'd open this task — land in review
  const [planMode, setPlanMode] = useState(
    () => Boolean(task && task.status === 'needs_input' && task.verdict?.subtasks?.length),
  );
  const [planCursor, setPlanCursor] = useState(0);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => ctx.setCapture(answering), [answering]);
  useEffect(() => () => ctx.setCapture(false), []);

  const approvePlan = (dispatchAfter: boolean) => {
    const subtasks = task?.verdict?.subtasks ?? [];
    const teamId = task?.issue.teamId;
    if (!task || !subtasks.length || creating) return;
    if (!teamId) return ctx.toast('parent issue has no team id — refresh issues', 'err');
    setCreating(true);
    void (async () => {
      try {
        const created = new Map<number, { id: string; identifier: string }>();
        for (let i = 0; i < subtasks.length; i++) {
          if (dropped.has(i)) continue;
          const st = subtasks[i];
          created.set(
            i,
            await createIssue(ctx.cfg, {
              teamId,
              title: st.title,
              description: `${st.description}\n\n_Split from ${task.issue.identifier} by colinear._`,
              priority: st.priority,
              parentId: task.issue.id,
            }),
          );
        }
        for (const [i, child] of created) {
          for (const dep of subtasks[i].blockedBy ?? []) {
            const blocker = created.get(dep);
            if (blocker) await createBlocksRelation(ctx.cfg, blocker.id, child.id);
          }
        }
        const names = [...created.values()].map((c) => c.identifier);
        store.addActivity(task.issue.id, `split into ${names.join(', ')}`);
        // the parent's work now lives in its sub-issues: track them and
        // auto-complete when they all land (refreshTracking keeps this fresh)
        store.update(task.issue.id, {
          status: 'tracking',
          subIssues: [...created.entries()].map(([i, c]) => ({
            id: c.id,
            identifier: c.identifier,
            title: subtasks[i].title,
            done: false,
          })),
        });
        ctx.toast(`created ${names.join(', ')}`, 'ok');
        if (dispatchAfter) {
          const issues = await fetchIssuesByIds(ctx.cfg, [...created.values()].map((c) => c.id));
          for (const [i, child] of created) {
            const issue = issues.find((x) => x.id === child.id);
            if (!issue) continue;
            const repo = ctx.cfg.repos.find((r) => r.name === subtasks[i].repo);
            ctx.dispatcher.enqueue([issue], { repo, skipTriage: true });
          }
          ctx.toast(`created + dispatched ${names.length} (dependencies queue automatically)`, 'ok');
          ctx.navigate('board');
        }
      } catch (err) {
        ctx.toast(`split failed: ${String(err).slice(0, 80)}`, 'err');
      } finally {
        setCreating(false);
        setPlanMode(false);
      }
    })();
  };

  // plan-review keys
  useInput(
    (input, key) => {
      const n = task?.verdict?.subtasks?.length ?? 0;
      if (key.escape || input === 'q') setPlanMode(false);
      if (key.upArrow || input === 'k') setPlanCursor((c) => Math.max(0, c - 1));
      if (key.downArrow || input === 'j') setPlanCursor((c) => Math.min(n - 1, c + 1));
      if (input === ' ') {
        setDropped((prev) => {
          const next = new Set(prev);
          if (next.has(planCursor)) next.delete(planCursor);
          else next.add(planCursor);
          return next;
        });
      }
      if (input === 'A') approvePlan(false);
      if (input === 'D') approvePlan(true);
    },
    { isActive: planMode && !ctx.cmdOpen },
  );

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
      const only = task.question?.questions.length === 1 ? task.question.questions[0] : undefined;
      if (!Number.isNaN(num) && only?.options[num - 1] && !answering) {
        task.question?.answer([only.options[num - 1].label]);
      }
      if (input === 'x') {
        if (ctx.dispatcher.cancel(task.issue.id)) ctx.toast(`cancelling ${task.issue.identifier}`, 'info');
        else ctx.toast('no live session to cancel', 'err');
      }
      if (input === 'P' && task.verdict?.subtasks?.length) setPlanMode(true);
      if (input === 's') attachSession(task, ctx);
      if (input === 'S') attachShell(task, ctx);
      if (input === 'r') {
        ctx.dispatcher.resume(task.issue.id);
        ctx.toast(`requeued ${task.issue.identifier}`, 'ok');
      }
      if (input === 'o' && task.prs[0]) execFile('open', [task.prs[0].url], () => {});
      if (input === 'O') execFile('open', [task.issue.url], () => {});
      if ((input === 'd' || input === 'D') && task.prs[0]?.isDraft) {
        // merge-order dependencies gate promotion, not the work. D overrides:
        // colinear knows when a blocker MERGED, never whether it deployed
        const holding = (task.blockedBy ?? []).filter((b) => !b.done);
        if (holding.length && input === 'd') {
          ctx.toast(
            `${task.issue.identifier} must land after ${holding.map((b) => b.identifier).join(', ')} — D promotes anyway`,
            'err',
          );
          return;
        }
        execFile('gh', ['pr', 'ready', String(task.prs[0].number)], { cwd: task.repo?.path ?? ctx.cfg.repo }, (err) => {
          if (err) ctx.toast(`gh pr ready failed`, 'err');
          else ctx.toast(`#${task.prs[0].number} marked ready`, 'ok');
        });
        if (holding.length) store.addActivity(task.issue.id, `promoted ahead of ${holding.map((b) => b.identifier).join(', ')}`);
      }
      if (input === 'f' && task.status === 'blocked') {
        ctx.dispatcher.force(task.issue.id);
        ctx.toast(`starting now — blockers still gate the merge`, 'ok');
      }
    },
    { isActive: !answering && !ctx.cmdOpen && !planMode },
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
          {' '}· {formatDuration(task, ctx.now) || '--:--'} · {formatTokensFull(task.tokens)} · $
          {task.costUsd.toFixed(2)}
          {task.repo ? ` · ${task.repo.name}` : ''}
          {task.branch ? ` · ${task.branch}` : ''}
        </Text>
      </Text>
      {task.instructions && (
        <Text dimColor wrap="truncate">
          instructions: {task.instructions}
        </Text>
      )}
      {task.sessionHistory?.length ? (
        <Text dimColor wrap="truncate">
          previous session{task.sessionHistory.length > 1 ? 's' : ''}:{' '}
          {task.sessionHistory
            .slice(-2)
            .map((s) => `claude --resume ${s.sessionId}${s.worktree ? ` (in ${s.worktree})` : ''}`)
            .join(' · ')}
        </Text>
      ) : null}
      {task.error && <Text color={theme.err}>✖ {task.error.slice(0, 200)}</Text>}
      {task.verdict && task.verdict.verdict !== 'do' && (
        <Text color={theme.err} wrap="truncate">
          {task.verdict.verdict}: {task.verdict.reason}
        </Text>
      )}

      {(task.verdict?.subtasks?.length ?? 0) > 0 && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={planMode ? theme.borderFocus : theme.border}
          paddingX={1}
        >
          <Text bold color={theme.header}>
            SPLIT PLAN ({(task.verdict!.subtasks!.length - dropped.size)}/{task.verdict!.subtasks!.length}){' '}
            <Text dimColor>
              {planMode
                ? creating
                  ? 'creating…'
                  : 'space: toggle · A: create sub-issues · D: create + dispatch · esc: done'
                : 'press P to review/approve'}
            </Text>
          </Text>
          {task.verdict!.subtasks!.map((st, i) => (
            <Text key={st.title} inverse={planMode && i === planCursor} wrap="truncate">
              {dropped.has(i) ? '○' : '◉'} {st.title}
              <Text dimColor>
                {st.repo ? ` [${st.repo}]` : ''}
                {st.blockedBy?.length ? ` ⛓ after #${st.blockedBy.map((d) => d + 1).join(',#')}` : ''}
              </Text>
            </Text>
          ))}
        </Box>
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

      {task.blockedBy?.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={theme.header}>
            {task.status === 'blocked' ? 'BLOCKED BY' : 'MERGE AFTER'}
          </Text>
          {task.blockedBy.map((b) => (
            <Text key={b.id} color={b.done ? theme.ok : theme.warn} wrap="truncate">
              {b.done ? '✔' : '⛓'} {b.identifier}
              <Text dimColor>
                {b.done
                  ? ' — landed'
                  : b.kind === 'merge'
                    ? " — this PR stays draft until it lands (D promotes anyway; colinear can't see deploys)"
                    : ' — f starts the work anyway'}
              </Text>
            </Text>
          ))}
        </Box>
      ) : null}

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

      {task.question && !answering && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={theme.info} paddingX={1}>
          {/* full view has room: wrap every question, never truncate them */}
          {task.question.questions.map((q, qi) => (
            <Box key={`${qi}-${q.text.slice(0, 12)}`} flexDirection="column">
              <Text color={theme.info} bold wrap="wrap">
                ? {q.header ? `[${q.header}] ` : ''}{q.text}
              </Text>
              {q.options.map((opt, i) => (
                <Text key={opt.label} color={theme.info} wrap="wrap">
                  {'  '}{i + 1}. {opt.label}
                  {opt.description ? <Text dimColor> — {opt.description}</Text> : null}
                </Text>
              ))}
            </Box>
          ))}
          <Text dimColor>
            a: answer{task.question.questions.length === 1 && task.question.questions[0].options.length
              ? ` · 1-${task.question.questions[0].options.length}: pick`
              : ''}
            {task.question.questions.length > 1 ? ` · ${task.question.questions.length} questions` : ''}
          </Text>
        </Box>
      )}
      {task.question && answering && (
        <AnswerModal
          subject={task.issue.identifier}
          question={task.question}
          width={ctx.size.columns}
          issueId={task.issue.id}
          onEdit={(path) => {
            const count = task.question?.questions.length ?? 1;
            setAnswering(false);
            setPendingAction({ kind: 'edit-answers', path, issueId: task.issue.id, count });
            ctx.quit();
          }}
          onCancel={() => setAnswering(false)}
          onSubmit={(answers) => {
            setAnswering(false);
            task.question?.answer(answers);
          }}
        />
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
  ['a', 'answer form'],
  ['P', 'review split plan'],
  ['x', 'cancel agent'],
  ['s', 'attach claude'],
  ['S', 'shell'],
  ['r', 'resume/retry'],
  ['d', 'PR ready'],
  ['f', 'force start'],
  ['o', 'open PR'],
  ['O', 'open issue'],
];
