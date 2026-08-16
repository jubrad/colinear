import { Box, Text, useInput, type Key } from 'ink';
import TextInput from 'ink-text-input';
import { execFile } from 'node:child_process';
import { useEffect, useState, type ReactNode } from 'react';
import { attachSession, attachShell, setPendingAction } from '../core/attach.js';
import { fetchSubIssues, postComment } from '../core/linear.js';
import { store } from '../core/store.js';
import type { Task } from '../core/types.js';
import { theme } from '../theme.js';
import { AnswerModal } from '../ui/AnswerModal.js';
import { useColinear } from '../ui/context.js';
import { EditTaskModal } from '../ui/EditTaskModal.js';
import { SubIssueModal, type SubIssueRow } from '../ui/SubIssueModal.js';

export interface TaskActions {
  /** a modal or the answer field owns the keyboard — gate useInput on this */
  busy: boolean;
  /** a modal is up: hide anything that would compete for vertical room */
  modalOpen: boolean;
  answering: boolean;
  endAnswer: () => void;
  /** render this somewhere in the view; null when nothing is open */
  modals: ReactNode;
  /** everything a task can have done to it, shared by the board and the list */
  handleKey: (input: string, key: Key, task: Task | undefined) => void;
}

/**
 * The verbs that apply to a task, independent of how it's being displayed.
 * The board and the task list are two renderings of one set of actions, and a
 * key that means "cancel" on the board has to mean it in the list too — so the
 * modals, their keyboard capture, and the handlers live here rather than in
 * either view.
 */
export function useTaskActions(): TaskActions {
  const ctx = useColinear();
  const [answering, setAnswering] = useState<Task | undefined>();
  const [subModal, setSubModal] = useState<{ parent: Task; rows: SubIssueRow[] }>();
  const [repoModal, setRepoModal] = useState<Task>();
  const [messaging, setMessaging] = useState<Task>();

  // modals own the keyboard: without capture, global keys stay live and a
  // ":" typed into the pin field (e.g. pasting a URL) opens the command bar
  const modalOpen = Boolean(subModal) || Boolean(repoModal) || Boolean(messaging) || Boolean(answering);
  useEffect(() => ctx.setCapture(modalOpen), [modalOpen]);
  useEffect(() => () => ctx.setCapture(false), []);

  const handleKey = (input: string, key: Key, selected: Task | undefined) => {
    if (input === 'n') ctx.navigate('issues');
    if (!selected) return;
    if (input === 'a' && selected.question) setAnswering(selected);
    // a bare number still answers a single-question ask outright — the common
    // case shouldn't need the form
    const num = Number.parseInt(input, 10);
    const only = selected.question?.questions.length === 1 ? selected.question.questions[0] : undefined;
    if (!Number.isNaN(num) && only?.options[num - 1]) {
      selected.question?.answer([only.options[num - 1].label]);
    }
    if (key.return) ctx.navigate('task', selected.issue.identifier);
    if (input === 'x') {
      if (ctx.dispatcher.cancel(selected.issue.id)) ctx.toast(`cancelling ${selected.issue.identifier}`, 'info');
    }
    if (input === 'r' && !selected.question) {
      ctx.dispatcher.resume(selected.issue.id);
      ctx.toast(`requeued ${selected.issue.identifier}`, 'ok');
    }
    if (input === 'f' && selected.status === 'blocked') {
      ctx.dispatcher.force(selected.issue.id);
      ctx.toast(`${selected.issue.identifier}: starting now — blockers still gate the merge`, 'ok');
    }
    if (input === 'b' && selected.prs.length) {
      ctx.dispatcher.rebase(selected.issue.id);
      ctx.toast(`rebasing ${selected.issue.identifier}`, 'info');
    }
    if (input === 's') attachSession(selected, ctx);
    if (input === 'S') attachShell(selected, ctx);
    if (input === 'm') setRepoModal(selected);
    if (input === 'M') setMessaging(selected);
    if (input === 'u') {
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
    if (input === 'o' && selected.prs[0]) {
      execFile('open', [selected.prs[0].url], () => {});
      ctx.toast(`opened #${selected.prs[0].number}`, 'info');
    }
    if (input === 'O') {
      execFile('open', [selected.issue.url], () => {});
      ctx.toast(`opened ${selected.issue.identifier} in Linear`, 'info');
    }
    if (input === 'c' && selected.verdict && selected.verdict.verdict !== 'do' && !selected.question && !selected.escalationCommented) {
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
  };

  const modals = (
    <>
      {subModal && (
        <SubIssueModal
          parent={subModal.parent.issue.identifier}
          rows={subModal.rows}
          onCancel={() => setSubModal(undefined)}
          onSubmit={(picked) => {
            setSubModal(undefined);
            // sub-issues default to the parent's repo; dependency queue orders them.
            // They came out of a split that already scoped them, so triaging
            // each one again just pays to re-derive the same answer.
            const repo = ctx.cfg.repos.find((r) => r.path === subModal.parent.repo?.path);
            ctx.dispatcher.enqueue(picked, { repo, skipTriage: true });
            // a parent with no PRs of its own is now just tracking its subs
            if (!subModal.parent.prs.length) {
              store.update(subModal.parent.issue.id, {
                status: 'tracking',
                subIssues: subModal.rows.map((r) => ({
                  id: r.issue.id,
                  identifier: r.issue.identifier,
                  title: r.issue.title,
                  done: r.disabled === 'done',
                })),
              });
            }
            ctx.toast(
              `dispatched ${picked.length} sub-issue${picked.length > 1 ? 's' : ''} of ${subModal.parent.issue.identifier}`,
              'ok',
            );
          }}
        />
      )}
      {answering?.question && (
        <AnswerModal
          subject={answering.issue.identifier}
          question={answering.question}
          width={ctx.size.columns}
          issueId={answering.issue.id}
          onEdit={(path) => {
            const id = answering.issue.id;
            const count = answering.question?.questions.length ?? 1;
            setAnswering(undefined);
            setPendingAction({ kind: 'edit-answers', path, issueId: id, count });
            ctx.quit();
          }}
          onCancel={() => setAnswering(undefined)}
          onSubmit={(answers) => {
            const q = answering.question;
            setAnswering(undefined);
            q?.answer(answers);
          }}
        />
      )}
      {messaging && (
        <MessageModal
          task={messaging}
          onCancel={() => setMessaging(undefined)}
          onSubmit={(text, wake) => {
            setMessaging(undefined);
            ctx.dispatcher.message(messaging.issue.id, text, { wake });
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
            ctx.dispatcher.applyEdits(repoModal.issue.id, edits);
          }}
        />
      )}
    </>
  );

  return {
    busy: modalOpen,
    modalOpen,
    answering: Boolean(answering),
    endAnswer: () => setAnswering(undefined),
    modals: subModal || repoModal || messaging || answering ? modals : null,
    handleKey,
  };
}

/**
 * Say something to a task's agent. A live one takes it at its next turn
 * boundary — it can't interrupt a bash command already running — and anything
 * else keeps it for the next session, so the key means the same thing on any
 * card.
 */
function MessageModal(props: {
  task: Task;
  onCancel: () => void;
  onSubmit: (text: string, wake: boolean) => void;
}) {
  const { task, onCancel, onSubmit } = props;
  const [draft, setDraft] = useState('');
  const live = ['triage', 'working', 'checks'].includes(task.status) || Boolean(task.maintenance);
  // mirrors Dispatcher.wake(): parked work stays parked, and a task already on
  // its way doesn't need starting
  const wakeable =
    !live && !task.question && !['queued', 'blocked', 'tracking'].includes(task.status);

  // same shape as EditTaskModal's ctrl+r: a modifier alongside the text input
  useInput((input, key) => {
    if (key.escape) onCancel();
    if (key.ctrl && input === 'q' && draft.trim()) onSubmit(draft, false);
  });

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="double" borderColor={theme.key} paddingX={2}>
      <Text bold color={theme.key}>
        message {task.issue.identifier}
      </Text>
      <Box>
        <Text color={theme.accent}>{'> '}</Text>
        <TextInput
          value={draft}
          placeholder={
            live
              ? 'the agent reads this at its next turn'
              : wakeable
                ? 'sending starts a session so the agent reads it'
                : "queued for this task's next session"
          }
          onChange={setDraft}
          onSubmit={(value) => (value.trim() ? onSubmit(value, true) : onCancel())}
        />
      </Box>
      <Text dimColor>
        {live
          ? 'picked up between turns — it will not interrupt a running command'
          : wakeable
            ? 'enter: send and wake the agent · ctrl+q: just queue it for later'
            : "parked work stays parked: this rides into the next session's prompt"}
        {' · esc: cancel'}
      </Text>
    </Box>
  );
}

/** Keys the two task views share, for the header's hotkey grid. */
export const TASK_ACTION_KEYS: Array<[string, string]> = [
  ['enter', 'task detail'],
  ['u', 'dispatch subs'],
  ['m', 'edit task'],
  ['M', 'message agent'],
  ['a', 'answer form'],
  ['x', 'cancel'],
  ['s', 'attach claude'],
  ['r', 'resume'],
  ['f', 'force start'],
  ['b', 'rebase'],
  ['c', 'escalate'],
  ['o', 'open PR'],
  ['O', 'open issue'],
  ['n', 'issues'],
];
