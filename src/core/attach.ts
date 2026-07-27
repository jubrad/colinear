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
      // New Ghostty instance running the attach script. --window-save-state=never
      // stops it restoring your existing tabs/splits into the new window.
      // (Ghostty has no IPC/AppleScript yet, so a tab in the current window
      // isn't scriptable — new window is the best it allows.)
      execFile(
        'open',
        ['-na', 'Ghostty.app', '--args', '--window-save-state=never', '-e', scriptPath],
        (err) => {
          if (err) log(`ghostty attach failed for ${task.issue.identifier}: ${err}`);
        },
      );
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

export interface PendingAttach {
  worktree: string;
  sessionId: string;
  identifier: string;
  /** transcript flush grace when a live agent was just suspended */
  waitMs: number;
}

let pending: PendingAttach | null = null;

/** index.tsx consumes this after the TUI unmounts to run claude in place. */
export function consumePendingAttach(): PendingAttach | null {
  const p = pending;
  pending = null;
  return p;
}

/**
 * Shared view action. Default mode hands THIS terminal to claude: the TUI
 * unmounts, `claude --resume` runs in place, and colinear re-renders when you
 * quit claude. Config terminal: "ghostty" | "terminal" opens a window instead.
 */
export function attachSession(
  task: Task,
  ctx: {
    cfg: Config;
    dispatcher: { suspend(id: string): boolean };
    toast: (text: string, kind?: 'info' | 'ok' | 'err') => void;
    quit: () => void;
  },
): void {
  if (!task.sessionId || !task.worktree) {
    ctx.toast('no session to attach yet', 'err');
    return;
  }
  const active = ACTIVE_STATUSES.includes(task.status);
  if (active) ctx.dispatcher.suspend(task.issue.id);

  if (ctx.cfg.terminal === 'ghostty' || ctx.cfg.terminal === 'terminal') {
    attachInTerminal(ctx.cfg, task, active ? 1500 : 0);
    ctx.toast(`${task.issue.identifier}: opening terminal${active ? ' (agent suspended)' : ''}`, 'info');
    return;
  }

  pending = {
    worktree: task.worktree,
    sessionId: task.sessionId,
    identifier: task.issue.identifier,
    waitMs: active ? 1500 : 0,
  };
  ctx.quit();
}
