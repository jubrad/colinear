#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { render } from 'ink';
import { App } from './app.js';
import { consumePendingAction } from './core/attach.js';
import { configPath, ensureConfigFile, loadConfig } from './core/config.js';
import { Dispatcher } from './core/dispatcher.js';
import { loadState, startPersistence } from './core/persist.js';
import { store } from './core/store.js';

const cfg = loadConfig();
const dispatcher = new Dispatcher(cfg);

loadState(cfg);
const stopPersistence = startPersistence();

// Synchronized output (DEC 2026): wrap every frame Ink writes so supporting
// terminals (iTerm2, Ghostty, Kitty, WezTerm) paint it atomically instead of
// showing the erase-then-rewrite as a flash. Terminals without it ignore the
// guards. Only active while the TUI owns the screen.
const realWrite = process.stdout.write.bind(process.stdout);
const syncWrite = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
  typeof chunk === 'string'
    ? (realWrite as (...args: unknown[]) => boolean)(`\x1b[?2026h${chunk}\x1b[?2026l`, ...rest)
    : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

const enterAltScreen = () => {
  realWrite('\x1b[?1049h\x1b[H');
  process.stdout.write = syncWrite;
};
const leaveAltScreen = () => {
  process.stdout.write = realWrite;
  realWrite('\x1b[?1049l');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The TUI runs in a loop so `s` (attach) can hand this terminal to an
// interactive `claude --resume` and drop back onto the board afterwards.
// Dispatched agents keep running in-process while claude has the screen.
async function main() {
  for (;;) {
    enterAltScreen();
    const app = render(<App cfg={cfg} dispatcher={dispatcher} />, { patchConsole: true });
    await app.waitUntilExit();
    leaveAltScreen();

    const action = consumePendingAction();
    if (!action) break;
    if (action.kind === 'attach' && action.mode === 'shell') {
      console.log(`shell in ${action.worktree} — exit to return to colinear\n`);
      spawnSync(process.env.SHELL ?? 'zsh', [], { cwd: action.worktree, stdio: 'inherit' });
    } else if (action.kind === 'attach') {
      if (action.waitMs) {
        console.log(`suspending ${action.identifier}'s agent…`);
        await sleep(action.waitMs);
      }
      console.log(`attaching to ${action.identifier} — quit claude (/exit) to return to colinear\n`);
      spawnSync('claude', ['--resume', action.sessionId ?? ''], {
        cwd: action.worktree,
        stdio: 'inherit',
      });
      // "background it": hand the conversation back to a headless agent
      if (store.get(action.issueId)?.status === 'interrupted') {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(
          `resume ${action.identifier}'s agent in the background? [Y/n] `,
        );
        rl.close();
        if (!/^n/i.test(answer.trim())) dispatcher.resume(action.issueId);
      }
    } else if (action.kind === 'edit-config') {
      const editPath = ensureConfigFile(cfg);
      spawnSync(process.env.EDITOR ?? 'vi', [editPath], { stdio: 'inherit' });
      // hot-apply: cfg is shared by reference, so mutating it updates the
      // dispatcher and all views on the next render
      Object.assign(cfg, loadConfig());
      console.log(`config reloaded from ${configPath()}`);
    }
  }
  // abort live agents (their sessions resume with r next run), flush state,
  // then exit hard — lingering SDK/child handles otherwise keep the event
  // loop alive and ctrl-c appears to hang
  dispatcher.shutdown();
  await sleep(200); // let aborts propagate + interrupted statuses land in the store
  stopPersistence();
  process.exit(0);
}

void main();
