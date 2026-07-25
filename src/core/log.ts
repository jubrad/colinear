import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = join(homedir(), '.local', 'state', 'foreman');
const LOG_FILE = join(STATE_DIR, 'foreman.log');

let ready = false;

export function log(msg: string): void {
  try {
    if (!ready) {
      mkdirSync(STATE_DIR, { recursive: true });
      ready = true;
    }
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // logging must never take the app down
  }
}
