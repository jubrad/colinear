import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR, log } from './log.js';
import type { Config, Task } from './types.js';

/**
 * Open a terminal running `claude --resume <session>` in the task's worktree.
 * The transcript is shared, so an interactive session picks up exactly where
 * the headless agent stopped — and a later `r` (resume) hands the same
 * conversation back to colinear.
 *
 * The command is written to a script file and executed directly (never typed
 * into the terminal), so shell config/prompts can't mangle it. Terminal
 * preference: config `terminal` ("ghostty" | "terminal"), else Ghostty when
 * installed, else Terminal.app.
 */
export function attachInTerminal(cfg: Config, task: Task, delayMs = 0): boolean {
  if (!task.sessionId || !task.worktree || process.platform !== 'darwin') return false;

  const scriptPath = join(STATE_DIR, `attach-${task.issue.identifier}.sh`);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      scriptPath,
      [
        '#!/bin/zsh',
        `cd ${JSON.stringify(task.worktree)} || exit 1`,
        `exec claude --resume ${task.sessionId}`,
        '',
      ].join('\n'),
    );
    chmodSync(scriptPath, 0o755);
  } catch (err) {
    log(`attach script write failed: ${err}`);
    return false;
  }

  const useGhostty =
    cfg.terminal === 'ghostty' || (cfg.terminal === undefined && existsSync('/Applications/Ghostty.app'));

  setTimeout(() => {
    if (useGhostty) {
      // opens a new Ghostty window running the attach script
      execFile('open', ['-na', 'Ghostty.app', '--args', '-e', scriptPath], (err) => {
        if (err) log(`ghostty attach failed for ${task.issue.identifier}: ${err}`);
      });
    } else {
      const osa = [
        'tell application "Terminal"',
        '  activate',
        `  do script "exec ${scriptPath.replace(/"/g, '\\"')}"`,
        'end tell',
      ].join('\n');
      execFile('osascript', ['-e', osa], (err) => {
        if (err) log(`terminal attach failed for ${task.issue.identifier}: ${err}`);
      });
    }
  }, delayMs);
  return true;
}

const ACTIVE_STATUSES = ['triage', 'working', 'checks'];

/** Shared view action: suspend a live agent if needed, then open the terminal. */
export function attachSession(
  task: Task,
  ctx: {
    cfg: Config;
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
    attachInTerminal(ctx.cfg, task, 1500);
    ctx.toast(`${task.issue.identifier}: agent suspended — opening terminal`, 'info');
  } else {
    attachInTerminal(ctx.cfg, task);
    ctx.toast(`opening terminal on ${task.issue.identifier}`, 'info');
  }
}
