import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A context is one config file plus its own state: separate daemon, socket,
 * task store, worktree bookkeeping and log. `coli --context work` (or
 * COLINEAR_CONTEXT) picks one, so a second Linear workspace, team or repo set
 * runs beside the default without either seeing the other's tasks.
 *
 * This module is a leaf on purpose. Everything that resolves a path — log,
 * protocol, persist, config — imports it, and ESM evaluates it first, so the
 * context is settled before anything derives a path from it.
 */
export const DEFAULT_CONTEXT = 'default';

export const CONFIG_DIR = join(homedir(), '.config', 'colinear');
export const CONTEXTS_DIR = join(CONFIG_DIR, 'contexts');

/** the default context's config file — and the base every context layers over */
export const BASE_CONFIG_PATHS = [join(CONFIG_DIR, 'config.json'), join(homedir(), '.colinear.json')];

const STATE_ROOT = join(homedir(), '.local', 'state', 'colinear');

function resolveContext(): string {
  const argv = process.argv.slice(2);
  const idx = argv.findIndex((a) => a === '--context' || a === '-c' || a.startsWith('--context='));
  const flag =
    idx === -1 ? undefined : argv[idx].includes('=') ? argv[idx].split('=').slice(1).join('=') : argv[idx + 1];
  const name = (flag ?? process.env.COLINEAR_CONTEXT ?? DEFAULT_CONTEXT).trim();
  // the name becomes a file name and a directory name; keep it boring
  if (!/^[\w.-]+$/.test(name)) {
    console.error(`invalid context name ${JSON.stringify(name)} — letters, digits, dot, dash, underscore`);
    process.exit(1);
  }
  return name;
}

export const CONTEXT = resolveContext();

// Children — the supervised TUI, the detached daemon — inherit the context
// through the environment instead of flag plumbing, so every spawn site stays
// unaware that contexts exist.
if (CONTEXT !== DEFAULT_CONTEXT) process.env.COLINEAR_CONTEXT = CONTEXT;

export function stateDirFor(name: string): string {
  return name === DEFAULT_CONTEXT ? STATE_ROOT : join(STATE_ROOT, 'contexts', name);
}

/**
 * COLINEAR_STATE_DIR isolates a run outright — its own socket, pidfile, state
 * and log. Tests set it so they can never collide with (or clobber the socket
 * of) the daemon holding your real work; it wins over the context's own dir.
 */
export const STATE_DIR = process.env.COLINEAR_STATE_DIR ?? stateDirFor(CONTEXT);

/** The config file a context is read from (and `:config`'s `e` edits). */
export function contextConfigPath(name = CONTEXT): string {
  if (name !== DEFAULT_CONTEXT) return join(CONTEXTS_DIR, `${name}.json`);
  return BASE_CONFIG_PATHS.find((p) => existsSync(p)) ?? BASE_CONFIG_PATHS[0];
}

/** Context names that have a config file, default first. */
export function listContexts(): string[] {
  let named: string[] = [];
  try {
    named = readdirSync(CONTEXTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    // no contexts directory: only the default context exists
  }
  return [DEFAULT_CONTEXT, ...named.filter((n) => n !== DEFAULT_CONTEXT)];
}
