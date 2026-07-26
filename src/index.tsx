#!/usr/bin/env node
import { render } from 'ink';
import { App } from './app.js';
import { loadConfig } from './core/config.js';
import { Dispatcher } from './core/dispatcher.js';
import { loadState, startPersistence } from './core/persist.js';

const cfg = loadConfig();
const dispatcher = new Dispatcher(cfg);

loadState(cfg);
const stopPersistence = startPersistence();

// Alternate screen buffer: fill the terminal, restore the shell on exit.
process.stdout.write('\x1b[?1049h\x1b[H');
const app = render(<App cfg={cfg} dispatcher={dispatcher} />, { patchConsole: true });
void app.waitUntilExit().finally(() => {
  stopPersistence();
  process.stdout.write('\x1b[?1049l');
});
