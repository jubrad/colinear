#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { App } from './app.js';
import { connectToDaemon } from './client.js';
import { consumePendingAction } from './core/attach.js';
import { configPath, ensureConfigFile, loadConfig } from './core/config.js';
import { runDaemon, PID_PATH } from './daemon.js';
import { findReclaimable, formatSize, removeWorktree } from './core/gc.js';
import { loadState } from './core/persist.js';
import { log } from './core/log.js';
import { SOCKET_PATH } from './core/protocol.js';
import { store } from './core/store.js';

/** exit code the TUI uses to ask the supervisor for a fresh process */
const RELOAD_EXIT = 75;

// Synchronized output (DEC 2026): wrap every frame Ink writes so supporting
// terminals (iTerm2, Ghostty, Kitty, WezTerm) paint it atomically instead of
// showing the erase-then-rewrite as a flash. Terminals without it ignore the
// guards. Only active while the TUI owns the screen.
const realWrite = process.stdout.write.bind(process.stdout);
const syncWrite = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
  typeof chunk === 'string'
    ? (realWrite as (...args: unknown[]) => boolean)(`\x1b[?2026h${chunk}\x1b[?2026l`, ...rest)
    : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

// stderr leaking from the SDK / libraries lands outside Ink's synchronized
// frames and tears the screen — divert it to the debug log while the TUI is up
const realErrWrite = process.stderr.write.bind(process.stderr);
const logErrWrite = ((chunk: string | Uint8Array) => {
  log(`stderr: ${String(chunk).trimEnd()}`);
  return true;
}) as typeof process.stderr.write;

const enterAltScreen = () => {
  realWrite('\x1b[?1049h\x1b[H');
  process.stdout.write = syncWrite;
  process.stderr.write = logErrWrite;
};
const leaveAltScreen = () => {
  process.stdout.write = realWrite;
  process.stderr.write = realErrWrite;
  realWrite('\x1b[?1049l');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function daemonPid(): number | undefined {
  if (!existsSync(PID_PATH)) return undefined;
  const pid = Number.parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) return undefined;
  try {
    process.kill(pid, 0); // signal 0 just tests liveness
    return pid;
  } catch {
    return undefined; // pidfile outlived the process
  }
}

/** `coli daemon [stop|status]` — the backend, and its lifecycle controls. */
async function daemonCommand(sub?: string): Promise<void> {
  const pid = daemonPid();
  if (sub === 'stop') {
    if (!pid) {
      console.log('no daemon running');
      if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      return;
    }
    process.kill(pid, 'SIGTERM');
    console.log(`stopped daemon (pid ${pid}) — agents were aborted and resume with r`);
    return;
  }
  if (sub === 'status') {
    console.log(pid ? `daemon running (pid ${pid}) on ${SOCKET_PATH}` : 'no daemon running');
    return;
  }
  if (pid) {
    console.error(`a daemon is already running (pid ${pid})`);
    process.exit(1);
  }
  await runDaemon();
}

/**
 * `coli gc [--yes] [--older-than N]` — reclaim worktree disk. Prints what it
 * would remove and stops there unless told otherwise: a worktree is cheap to
 * recreate but the printout is the only chance to notice one you still want.
 */
async function gcCommand(args: string[]): Promise<void> {
  const cfg = loadConfig({ requireKey: false });
  const yes = args.includes('--yes') || args.includes('-y');
  const idx = args.findIndex((a) => a === '--older-than');
  const olderThanDays = idx !== -1 ? Number.parseFloat(args[idx + 1] ?? '7') : 7;

  // read the daemon's state file rather than talking to it: gc is a disk
  // chore, and it should work whether or not colinear is running
  loadState(cfg);
  const tasks = store.list();
  if (!tasks.length) {
    console.log(
      'no tasks in state — every worktree would look orphaned, so only stale review\n' +
        'checkouts are considered. Is COLINEAR_STATE_DIR pointing somewhere unexpected?',
    );
  }
  const items = await findReclaimable(cfg, tasks, store.listReviews(), olderThanDays);
  if (!items.length) {
    console.log('nothing to reclaim');
    return;
  }

  let total = 0;
  for (const item of items) {
    total += item.kilobytes;
    console.log(
      `${formatSize(item.kilobytes).padStart(7)}  ${item.label.padEnd(12)} ${item.reason.padEnd(9)} ${Math.floor(item.ageDays)}d  ${item.path}`,
    );
  }
  console.log(`\n${items.length} worktrees · ${formatSize(total)}`);

  if (!yes) {
    console.log(`\nnothing removed. re-run with --yes to reclaim it` +
      (olderThanDays === 7 ? ' (finished tasks newer than 7d are kept; --older-than N to change)' : ''));
    return;
  }
  for (const item of items) {
    process.stdout.write(`removing ${item.path} … `);
    await removeWorktree(item);
    console.log('done');
  }
  console.log(`\nreclaimed ${formatSize(total)}`);
}

/**
 * The TUI: a client of the daemon. Everything stateful lives over there, so
 * quitting, reloading, or crashing this process leaves the agents alone.
 */
async function runTui(): Promise<void> {
  const conn = await connectToDaemon();
  const cfg = conn.cfg;
  let reload = false;

  // The TUI runs in a loop so `s` (attach) can hand this terminal to an
  // interactive `claude --resume` and drop back onto the board afterwards.
  for (;;) {
    enterAltScreen();
    const app = render(<App cfg={cfg} dispatcher={conn.dispatcher} onToast={conn.onToast} onGc={conn.onGc} />, { patchConsole: true });
    await app.waitUntilExit();
    leaveAltScreen();

    const action = consumePendingAction();
    if (!action) break;
    if (action.kind === 'reload-ui') {
      reload = true;
      break;
    }
    if (action.kind === 'attach' && action.mode === 'shell') {
      console.log(`shell in ${action.worktree} — exit to return to colinear\n`);
      spawnSync(process.env.SHELL ?? 'zsh', [], { cwd: action.worktree, stdio: 'inherit' });
    } else if (action.kind === 'attach') {
      if (action.waitMs) {
        console.log(`suspending ${action.identifier}'s agent…`);
        await sleep(action.waitMs);
      }
      console.log(`attaching to ${action.identifier} — quit claude (/exit) to return to colinear\n`);
      spawnSync('claude', ['--resume', action.sessionId ?? '', '--permission-mode', cfg.attachPermissionMode], {
        cwd: action.worktree,
        stdio: 'inherit',
      });
      // "background it": hand the conversation back to a headless agent
      if (store.get(action.issueId)?.status === 'interrupted') {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`resume ${action.identifier}'s agent in the background? [Y/n] `);
        rl.close();
        if (!/^n/i.test(answer.trim())) conn.dispatcher.resume(action.issueId);
      }
    } else if (action.kind === 'edit-file') {
      spawnSync(process.env.EDITOR ?? 'vi', [action.path], { stdio: 'inherit' });
      conn.dispatcher.reloadReviewDoc(action.reviewId);
    } else if (action.kind === 'edit-config') {
      const editPath = ensureConfigFile(cfg);
      spawnSync(process.env.EDITOR ?? 'vi', [editPath], { stdio: 'inherit' });
      Object.assign(cfg, loadConfig());
      conn.dispatcher.reloadConfig();
      console.log(`config reloaded from ${configPath()}`);
    }
  }

  conn.close();
  // agents keep running in the daemon; only this client goes away
  process.exit(reload ? RELOAD_EXIT : 0);
}

/**
 * Default entry: a thin supervisor around the TUI, so `R` can restart the
 * frontend on new code without disturbing the daemon (and its agents).
 */
function supervise(): never {
  const script = fileURLToPath(import.meta.url);
  for (;;) {
    // execArgv carries the loader in dev (tsx), where the script is .tsx
    const result = spawnSync(process.execPath, [...process.execArgv, script, '--tui'], { stdio: 'inherit' });
    if (result.status !== RELOAD_EXIT) process.exit(result.status ?? 0);
  }
}

const [command, sub] = process.argv.slice(2);
if (command === 'daemon') await daemonCommand(sub);
else if (command === 'gc') await gcCommand(process.argv.slice(3));
else if (command === '--tui') await runTui();
else supervise();
