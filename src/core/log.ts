import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './context.js';

// re-exported because everything that writes under the state dir already
// imports this module; the context is what decides where that is
export { STATE_DIR };

const LOG_FILE = join(STATE_DIR, 'colinear.log');

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
