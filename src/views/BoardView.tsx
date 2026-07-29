import { Box, Text, useInput } from 'ink';
import { execFile } from 'node:child_process';
import { useEffect, useMemo, useState } from 'react';
import { attachSession, attachShell } from '../core/attach.js';
import { useTasks } from '../core/hooks.js';
import { fetchSubIssues, postComment } from '../core/linear.js';
import { pollPrs } from '../core/prs.js';
import { store } from '../core/store.js';
import type { Task, TaskStatus } from '../core/types.js';
import { useColinear } from '../ui/context.js';
import { formatDuration, formatTokens, reviewStatus, spinner } from '../ui/format.js';
import { EditTaskModal, type TaskEdits } from '../ui/EditTaskModal.js';
import { SubIssueModal, type SubIssueRow } from '../ui/SubIssueModal.js';
import { STATUS_COLORS, theme } from '../theme.js';
import { DetailPane } from './DetailPane.js';

interface BoardColumn {
  title: string;
  statuses: TaskStatus[];
}

const COLUMNS: BoardColumn[] = [
  { title: 'Queued', statuses: ['queued', 'blocked', 'interrupted'] },
  { title: 'Triage', statuses: ['triage'] },
  { title: 'Working', statuses: ['working', 'checks'] },
  { title: 'Needs Input', statuses: ['needs_input'] },
  { title: 'PR Open', statuses: ['pr_open'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Failed', statuses: ['escalated', 'error'] },
];

const ACTIVE_STATUSES: TaskStatus[] = ['triage', 'working', 'checks'];

export function columnTasks(tasks: Task[]): Task[] {
  return COLUMNS.flatMap((col) => tasks.filter((t) => col.statuses.includes(t.status)));
}

export function BoardView(_props: { param?: string }) {
  const ctx = useColinear();
  const tasks = useTasks();
  const [pos, setPos] = useState({ col: 0, row: 0 });
  const [answering, setAnswering] = useState(false);
  const [subModal, setSubModal] = useState<{ parent: Task; rows: SubIssueRow[] }>();
  const [repoModal, setRepoModal] = useState<Task>();

  // grid[col] = tasks in that board column, in render order
  const grid = useMemo(
    () => COLUMNS.map((col) => tasks.filter((t) => col.statuses.includes(t.status))),
    [tasks, store.version],
  );

  // keep the cursor on a real card as tasks move between columns
  useEffect(() => {
    setPos((p) => {
      if (grid[p.col]?.length) return { col: p.col, row: Math.min(p.row, grid[p.col].length - 1) };
      const near = grid.findIndex((g, i) => g.length && i >= p.col);
      const before = grid.map((g, i) => (g.length ? i : -1)).filter((i) => i !== -1 && i < p.col);
      const col = near !== -1 ? near : (before[before.length - 1] ?? -1);
      return col === -1 ? { col: 0, row: 0 } : { col, row: 0 };
    });
  }, [grid]);

  const selected = grid[pos.col]?.[Math.min(pos.row, Math.max(0, (grid[pos.col]?.length ?? 1) - 1))];

  const moveCol = (dir: 1 | -1) =>
    setPos((p) => {
      let col = p.col;
      do {
        col += dir;
      } while (col >= 0 && col < grid.length && !grid[col].length);
      if (col < 0 || col >= grid.length) return p;
      return { col, row: Math.min(p.row, grid[col].length - 1) };
    });

  const moveRow = (dir: 1 | -1) =>
    setPos((p) => ({
      col: p.col,
      row: Math.max(0, Math.min((grid[p.col]?.length ?? 1) - 1, p.row + dir)),
    }));

  useEffect(() => ctx.setCapture(answering), [answering]);
  useEffect(() => () => ctx.setCapture(false), []);

  useInput(
    (input, key) => {
      // ijkl: i/k walk cards in a column, j/l jump columns (arrows too)
      if (key.leftArrow || input === 'j') moveCol(-1);
      if (key.rightArrow || input === 'l') moveCol(1);
      if (key.upArrow || input === 'i') moveRow(-1);
      if (key.downArrow || input === 'k') moveRow(1);
      if (input === 'a' && selected?.question) setAnswering(true);
      if (input === 'n') ctx.navigate('issues');
      if (key.return && selected) ctx.navigate('task', selected.issue.identifier);
      if (input === 'x' && selected) {
        if (ctx.dispatcher.cancel(selected.issue.id)) ctx.toast(`cancelling ${selected.issue.identifier}`, 'info');
      }
      if (input === 'r' && selected && !selected.question) {
        ctx.dispatcher.resume(selected.issue.id);
        ctx.toast(`requeued ${selected.issue.identifier}`, 'ok');
      }
      if (input === 's' && selected) attachSession(selected, ctx);
      if (input === 'S' && selected) attachShell(selected, ctx);
      if (input === 'm' && selected) setRepoModal(selected);
      if (input === 'u' && selected) {
        void fetchSubIssues(ctx.cfg, selected.issue.id)
          .then((subs) => {
            if (!subs.length) {
              ctx.toast(`${selected.issue.identifier} has no sub-issues`, 'info');
              return;
            }
            setSubModal({
              parent: selected,
              rows: subs.map((issue) => ({
                issue,
                disabled:
                  issue.stateType === 'completed' ? ('done' as const) : store.get(issue.id) ? ('on board' as const) : undefined,
              })),
            });
          })
          .catch(() => ctx.toast('failed to fetch sub-issues', 'err'));
      }
      if (input === 'o' && selected?.prs[0]) {
        execFile('open', [selected.prs[0].url], () => {});
        ctx.toast(`opened #${selected.prs[0].number}`, 'info');
      }
      if (input === 'O' && selected) {
        execFile('open', [selected.issue.url], () => {});
        ctx.toast(`opened ${selected.issue.identifier} in Linear`, 'info');
      }
      if (input === 'c' && selected?.verdict && selected.verdict.verdict !== 'do' && !selected.question && !selected.escalationCommented) {
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
    { isActive: !answering && !subModal && !repoModal && !ctx.cmdOpen },
  );

  if (!tasks.length) {
    return (
      <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
        <Text dimColor>No agents dispatched yet.</Text>
        <Text dimColor>
          press <Text color={theme.key}>n</Text> to pick issues
        </Text>
      </Box>
    );
  }

  const colWidth = Math.max(18, Math.floor((ctx.size.columns - COLUMNS.length) / COLUMNS.length));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {subModal && (
        <SubIssueModal
          parent={subModal.parent.issue.identifier}
          rows={subModal.rows}
          onCancel={() => setSubModal(undefined)}
          onSubmit={(picked) => {
            setSubModal(undefined);
            // sub-issues default to the parent's repo; dependency queue orders them
            const repo = ctx.cfg.repos.find((r) => r.path === subModal.parent.repo?.path);
            ctx.dispatcher.enqueue(picked, { repo });
            ctx.toast(
              `dispatched ${picked.length} sub-issue${picked.length > 1 ? 's' : ''} of ${subModal.parent.issue.identifier}`,
              'ok',
            );
          }}
        />
      )}
      {repoModal && (
        <EditTaskModal
          task={repoModal}
          repos={ctx.cfg.repos}
          onCancel={() => setRepoModal(undefined)}
          onSubmit={(edits) => {
            setRepoModal(undefined);
            applyTaskEdits(repoModal, edits, ctx);
          }}
        />
      )}
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
        {task.repo ? ` · ${task.repo.name}` : ''}
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
      {task.status === 'blocked' && task.blockedBy && (
        <Text color={STATUS_COLORS.blocked} wrap="truncate">
          ⛓ {task.blockedBy.map((b) => b.identifier).join(', ')}
        </Text>
      )}
      {task.verdict && task.verdict.verdict !== 'do' && (
        <Text color={theme.err} wrap="truncate">
          {task.verdict.verdict === 'too_big' ? '⛰ too big' : '? needs info'}
          {task.verdict.subtasks?.length ? (
            <Text color={theme.info}> — enter: review {task.verdict.subtasks.length}-issue plan</Text>
          ) : null}
        </Text>
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

function applyTaskEdits(task: Task, edits: TaskEdits, ctx: ReturnType<typeof useColinear>) {
  const id = task.issue.id;
  const pinChanged = edits.pinnedPr !== task.pinnedPr;
  store.update(id, {
    instructions: edits.instructions,
    model: edits.model,
    pinnedPr: edits.pinnedPr,
  });
  if (pinChanged) {
    // drop the stale match and re-poll so the pinned PR shows up right away
    store.update(id, { prs: [] });
    void pollPrs(ctx.cfg, ctx.dispatcher);
    ctx.toast(
      edits.pinnedPr ? `${task.issue.identifier} pinned to #${edits.pinnedPr}` : `${task.issue.identifier} PR match back to auto`,
      'ok',
    );
  }
  const repoChanged = edits.repo.path !== (task.repo?.path ?? ctx.cfg.repos[0].path);
  if (edits.requeue || repoChanged) {
    if (['triage', 'working', 'checks'].includes(store.get(id)?.status ?? '')) {
      ctx.toast('agent is live — x to cancel before requeueing', 'err');
      return;
    }
    if (ctx.dispatcher.redispatch(id, edits.repo, { retriage: edits.retriage })) {
      ctx.toast(`${task.issue.identifier} requeued in ${edits.repo.name}`, 'ok');
    }
  } else if (!pinChanged) {
    ctx.toast(`${task.issue.identifier} updated`, 'ok');
  }
}

function progressBar(done: number, total: number, width = 8): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const boardKeys: Array<[string, string]> = [
  ['j/l ←→', 'column'],
  ['i/k ↑↓', 'card'],
  ['enter', 'task detail'],
  ['u', 'dispatch subs'],
  ['m', 'edit task'],
  ['a', 'answer'],
  ['x', 'cancel'],
  ['s', 'attach claude'],
  ['S', 'shell'],
  ['r', 'resume'],
  ['c', 'escalate'],
  ['o', 'open PR'],
  ['O', 'open issue'],
  ['n', 'issues'],
];
