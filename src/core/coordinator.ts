import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './log.js';
import { store } from './store.js';
import type { PlannedSubtask, Task } from './types.js';

/**
 * A tracking parent's coordinator session (EXPERIMENTAL, part of the
 * coordination experiment).
 *
 * A parent whose work happens in sub-issues has no session of its own, so
 * there was nobody to tell "cancel that one" or "we need another sub-issue for
 * the migration". Waking it starts an agent that manages the family instead of
 * writing code: it can look at what the sub-issues are doing, message them,
 * cancel one, and propose new ones.
 *
 * It creates Linear issues only when asked. Left to itself it proposes: the
 * proposals land on the parent card, and enter, then `A` (or `D`) approves
 * them. A turn the operator opened with a message also gets family_create,
 * because their asking is the approval; a coordinator woken by anything else
 * never has it, so it cannot spawn issues unattended.
 */
export interface CoordinatorTools {
  /** live state of the family, fresher than whatever the prompt said */
  status(): string;
  /** send a sibling's agent a message (waking it if it is idle) */
  message(identifier: string, text: string): string;
  /** stop a sibling's session */
  cancel(identifier: string, reason: string): string;
  /** offer new sub-issues for the operator to approve */
  propose(subtasks: PlannedSubtask[]): string;
  /**
   * Create sub-issues, and start them if asked — present only in a turn the
   * operator opened with a message, since their asking is the approval. The
   * pending proposals (all, or the ones named by title) and/or new ones.
   */
  create?(opts: { titles?: string[]; subtasks?: PlannedSubtask[]; start: boolean }): Promise<string>;
}

/** Scratch cwd: a coordinator has no code to edit, so it gets no checkout. */
export function coordinatorCwd(task: Task): string {
  if (task.worktree) return task.worktree; // reuse one it already has
  const dir = join(STATE_DIR, 'coordinator', task.issue.identifier.replace(/[^\w.-]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One line per sub-issue: colinear's live view, not Linear's cached one. */
export function familyStatus(parent: Task): string {
  const subs = parent.subIssues ?? [];
  // what is proposed and not yet approved is part of the family's state: a
  // coordinator that cannot see its own proposal proposes it again, or tells
  // the operator there is nothing left to create
  const pending = parent.proposals ?? [];
  const proposed = pending.length
    ? `\n\nProposed, waiting for the operator to approve (NOT created yet — do not propose these again):\n${pending.map((p) => `- ${p.title}`).join('\n')}\nThe operator approves them on ${parent.issue.identifier}: enter opens the proposals, A creates them, D creates and starts them.`
    : '';
  if (!subs.length) return `This issue has no sub-issues.${proposed}`;
  return subs
    .map((sub) => {
      const task = store.get(sub.id);
      if (!task) return `- ${sub.identifier} ${sub.title} — ${sub.done ? 'done' : 'not dispatched'}`;
      const pr = task.prs[0];
      const bits: string[] = [task.status];
      if (task.maintenance) bits.push(task.maintenance);
      if (pr) bits.push(`PR #${pr.number} ${pr.isDraft ? 'draft' : pr.state.toLowerCase()} ${pr.checksStatus}`);
      if (task.blockedBy?.length) bits.push(`blocked by ${task.blockedBy.map((b) => b.identifier).join(', ')}`);
      if (task.error) bits.push(`error: ${task.error.slice(0, 80)}`);
      const last = task.activity.at(-1);
      return `- ${sub.identifier} ${sub.title} — ${bits.join(' · ')}${last ? `\n    last: ${last.slice(0, 100)}` : ''}`;
    })
    .join('\n') + proposed;
}

export function coordinatorPrompt(parent: Task, channelIds: string[], messages: string[]): string {
  const lines = [
    `# Coordinating ${parent.issue.identifier}: ${parent.issue.title}`,
    '',
    'You are the coordinator for this issue family. The work itself is being done by agents on the',
    'sub-issues below — you are not writing code, and you have no checkout to write it in.',
    '',
    '## Sub-issues',
    familyStatus(parent),
    '',
    '## What you can do',
    '- mcp__colinear__family_status — the live state of every sub-issue (use it before deciding anything)',
    '- mcp__colinear__family_message — send a sub-issue\'s agent an instruction; an idle one is woken to read it',
    '- mcp__colinear__family_cancel — stop a sub-issue\'s agent (it can be resumed later by the operator)',
    '- mcp__colinear__family_propose — propose new sub-issues. This does NOT create them: the operator approves',
    '  them. Say so when you propose, rather than reporting them as created,',
    `  and tell them how: enter on ${parent.issue.identifier} opens the proposals, A creates them, D creates and`,
    '  starts them. If the operator asks you to create or start one, the answer is the same — propose it (once;',
    '  check family_status for what is already proposed) and give them those keys.',
    ...(messages.length
      ? [
          '- mcp__colinear__family_create — create sub-issues, and start their agents with start: true. You may use',
          '  it in this turn because the operator messaged you: use it ONLY if their message asks you to create or',
          '  start sub-issues (their asking is the approval). It creates the pending proposals — all of them, or the',
          '  ones you name by title — and/or new ones you pass. Anything else: propose instead.',
        ]
      : []),
  ];
  if (channelIds.length) {
    lines.push(
      `- mcp__colinear__channel_read / channel_post — your channels: ${channelIds.join(', ')}. The family`,
      '  channel is where the sub-issue agents post scope claims and decisions; read it first. A project',
      '  channel, if you have one, reaches the other families working the same project — use it for what',
      '  crosses family lines, not for family business.',
    );
  }
  lines.push(
    '',
    '## The operator asked for this',
    messages.length
      ? messages.map((m) => `- ${m}`).join('\n')
      : '- (nothing specific — check on the family, report what is happening, and stop)',
    '',
    'Act on what was asked, then stop and report briefly. Do not start work that belongs to a sub-issue,',
    'and do not invent activity to look busy: "everything is progressing, nothing needed" is a fine answer.',
  );
  return lines.join('\n');
}
