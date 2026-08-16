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
 * It cannot create Linear issues. Proposals land on the parent card and you
 * press `A` — nothing reaches Linear without the operator asking, and an agent
 * that can spawn issues unattended is exactly the thing that rule is for.
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
  if (!subs.length) return 'This issue has no sub-issues.';
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
    .join('\n');
}

export function coordinatorPrompt(parent: Task, channel: string | undefined, messages: string[]): string {
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
    '- mcp__colinear__family_propose — propose new sub-issues. This does NOT create them: the operator',
    '  reviews your proposal and approves it. Say so when you propose, rather than reporting them as created.',
  ];
  if (channel) {
    lines.push(
      `- mcp__colinear__channel_read / channel_post — the family channel ${channel}, shared with every`,
      '  sub-issue agent. Read it first: the agents post scope claims and decisions there.',
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
