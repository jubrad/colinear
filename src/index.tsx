#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { render } from 'ink';
import { App } from './app.js';
import { consumePendingAction } from './core/attach.js';
import { configPath, loadConfig } from './core/config.js';
import { Dispatcher } from './core/dispatcher.js';
import { loadState, startPersistence } from './core/persist.js';

const cfg = loadConfig();
const dispatcher = new Dispatcher(cfg);

loadState(cfg);
const stopPersistence = startPersistence();

const enterAltScreen = () => process.stdout.write('\x1b[?1049h\x1b[H');
const leaveAltScreen = () => process.stdout.write('\x1b[?1049l');

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
    if (action.kind === 'attach') {
      if (action.waitMs) {
        console.log(`suspending ${action.identifier}'s agent…`);
        await sleep(action.waitMs);
      }
      console.log(`attaching to ${action.identifier} — quit claude to return to colinear\n`);
      spawnSync('claude', ['--resume', action.sessionId], {
        cwd: action.worktree,
        stdio: 'inherit',
      });
    } else if (action.kind === 'edit-config') {
      spawnSync(process.env.EDITOR ?? 'vi', [action.path], { stdio: 'inherit' });
      // hot-apply: cfg is shared by reference, so mutating it updates the
      // dispatcher and all views on the next render
      Object.assign(cfg, loadConfig());
      console.log(`config reloaded from ${configPath()}`);
    }
  }
  stopPersistence();
}

void main();
