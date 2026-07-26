import { execFile } from 'node:child_process';
import { log } from './log.js';
import type { Task } from './types.js';

/**
 * Open a real terminal window running `claude --resume <session>` in the
 * task's worktree. The transcript is shared, so an interactive session picks
 * up exactly where the headless agent stopped — and a later `r` (resume)
 * hands the same conversation back to colinear.
 */
export function attachInTerminal(task: Task, delayMs = 0): boolean {
  if (!task.sessionId || !task.worktree || process.platform !== 'darwin') return false;
  const shellCmd = `cd '${task.worktree.replace(/'/g, `'\\''`)}' && claude --resume ${task.sessionId}`;
  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "${shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    'end tell',
  ].join('\n');
  setTimeout(() => {
    execFile('osascript', ['-e', script], (err) => {
      if (err) log(`attach failed for ${task.issue.identifier}: ${err}`);
    });
  }, delayMs);
  return true;
}

const ACTIVE_STATUSES = ['triage', 'working', 'checks'];

/** Shared view action: suspend a live agent if needed, then open the terminal. */
export function attachSession(
  task: Task,
  ctx: {
    dispatcher: { suspend(id: string): boolean };
    toast: (text: string, kind?: 'info' | 'ok' | 'err') => void;
  },
): void {
  if (!task.sessionId || !task.worktree) {
    ctx.toast('no session to attach yet', 'err');
    return;
  }
  if (ACTIVE_STATUSES.includes(task.status)) {
    ctx.dispatcher.suspend(task.issue.id);
    // small delay so the SDK finishes flushing the transcript before claude opens it
    attachInTerminal(task, 1500);
    ctx.toast(`${task.issue.identifier}: agent suspended — opening Terminal`, 'info');
  } else {
    attachInTerminal(task);
    ctx.toast(`opening Terminal on ${task.issue.identifier}`, 'info');
  }
}
