#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { render } from 'ink';
import { App } from './app.js';
import { consumePendingAttach } from './core/attach.js';
import { loadConfig } from './core/config.js';
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

    const attach = consumePendingAttach();
    if (!attach) break;
    if (attach.waitMs) {
      console.log(`suspending ${attach.identifier}'s agent…`);
      await sleep(attach.waitMs);
    }
    console.log(`attaching to ${attach.identifier} — quit claude to return to colinear\n`);
    spawnSync('claude', ['--resume', attach.sessionId], {
      cwd: attach.worktree,
      stdio: 'inherit',
    });
  }
  stopPersistence();
}

void main();
