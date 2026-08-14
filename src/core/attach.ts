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
export function attachInTerminal(cfg: Config, target: Attachable, delayMs = 0): boolean {
  if (!target.sessionId || !target.worktree || process.platform !== 'darwin') return false;

  const scriptPath = join(STATE_DIR, `attach-${target.identifier.replace(/[^\w.-]/g, '-')}.sh`);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      scriptPath,
      [
        '#!/bin/zsh',
        `cd ${JSON.stringify(target.worktree)} || exit 1`,
        // headless agents run auto-accept; the interactive session should too
        `exec claude --resume ${target.sessionId} --permission-mode ${cfg.attachPermissionMode}`,
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
          if (err) log(`ghostty attach failed for ${target.identifier}: ${err}`);
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
        if (err) log(`terminal attach failed for ${target.identifier}: ${err}`);
      });
    }
  }, delayMs);
  return true;
}

const ACTIVE_STATUSES = ['triage', 'working', 'checks'];

/** What attaching needs: tasks and PR reviews both qualify. */
export interface Attachable {
  id: string;
  identifier: string;
  sessionId?: string;
  worktree?: string;
  /** an agent is mid-session, so it must be suspended before we take over */
  live: boolean;
}

const asAttachable = (task: Task): Attachable => ({
  id: task.issue.id,
  identifier: task.issue.identifier,
  sessionId: task.sessionId,
  worktree: task.worktree,
  live: ACTIVE_STATUSES.includes(task.status),
});

export type PendingAction =
  | {
      kind: 'attach';
      mode: 'claude' | 'shell';
      worktree: string;
      sessionId?: string;
      identifier: string;
      issueId: string;
      /** transcript flush grace when a live agent was just suspended */
      waitMs: number;
    }
  | { kind: 'edit-config'; path: string }
  /** open a file in $EDITOR, then tell the daemon to re-read it */
  | { kind: 'edit-file'; path: string; reviewId: string }
  /** restart the TUI process on new code; the daemon and its agents stay up */
  | { kind: 'reload-ui' };

let pending: PendingAction | null = null;

export function setPendingAction(action: PendingAction): void {
  pending = action;
}

/** index.tsx consumes this after the TUI unmounts to run a child in place. */
export function consumePendingAction(): PendingAction | null {
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
  attachTo(asAttachable(task), ctx.cfg, (id) => ctx.dispatcher.suspend(id), ctx.toast, ctx.quit);
}

/**
 * Hand the terminal to `claude --resume` on this session. A live agent is
 * suspended first — one writer per transcript — and the caller decides what
 * suspending means for its own kind of work.
 */
export function attachTo(
  target: Attachable,
  cfg: Config,
  suspend: (id: string) => void,
  toast: (text: string, kind?: 'info' | 'ok' | 'err') => void,
  quit: () => void,
): void {
  if (!target.sessionId || !target.worktree) {
    toast('no session to attach yet', 'err');
    return;
  }
  if (target.live) suspend(target.id);

  if (cfg.terminal === 'ghostty' || cfg.terminal === 'terminal') {
    attachInTerminal(cfg, target, target.live ? 1500 : 0);
    toast(`${target.identifier}: opening terminal${target.live ? ' (agent suspended)' : ''}`, 'info');
    return;
  }

  pending = {
    kind: 'attach',
    mode: 'claude',
    worktree: target.worktree,
    sessionId: target.sessionId,
    identifier: target.identifier,
    issueId: target.id,
    waitMs: target.live ? 1500 : 0,
  };
  quit();
}

/** Drop into a plain shell in the task's worktree (agent keeps running). */
export function attachShell(
  task: Task,
  ctx: { toast: (text: string, kind?: 'info' | 'ok' | 'err') => void; quit: () => void },
): void {
  if (!task.worktree) {
    ctx.toast('no worktree yet', 'err');
    return;
  }
  pending = {
    kind: 'attach',
    mode: 'shell',
    worktree: task.worktree,
    identifier: task.issue.identifier,
    issueId: task.issue.id,
    waitMs: 0,
  };
  ctx.quit();
}
