import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * COLINEAR_STATE_DIR isolates a run — its own socket, pidfile, state and log.
 * Tests set it so they can never collide with (or clobber the socket of) the
 * daemon holding your real work.
 */
export const STATE_DIR =
  process.env.COLINEAR_STATE_DIR ?? join(homedir(), '.local', 'state', 'colinear');
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
