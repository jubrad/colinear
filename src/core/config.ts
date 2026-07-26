import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './types.js';

const CONFIG_PATHS = [
  join(homedir(), '.config', 'colinear', 'config.json'),
  join(homedir(), '.colinear.json'),
];

export function loadConfig(): Config {
  let raw: Partial<Config> = {};
  for (const path of CONFIG_PATHS) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
      break;
    } catch {
      // try the next location; fall back to defaults + env
    }
  }

  const linearApiKey = raw.linearApiKey ?? process.env.LINEAR_API_KEY ?? '';
  if (!linearApiKey) {
    console.error(
      `No Linear API key. Set LINEAR_API_KEY or add "linearApiKey" to ${CONFIG_PATHS[0]}`,
    );
    process.exit(1);
  }

  const repo = expandHome(raw.repo ?? join(homedir(), 'work', 'cloud'));

  // --team FLAG (or --team=FLAG) overrides the config file
  let team = raw.team;
  const argv = process.argv.slice(2);
  const flagIdx = argv.findIndex((a) => a === '--team' || a.startsWith('--team='));
  if (flagIdx !== -1) {
    const arg = argv[flagIdx];
    team = arg.includes('=') ? arg.split('=')[1] : argv[flagIdx + 1];
  }

  return {
    // "all" (any case) = every team, k9s-style
    team: team === undefined ? undefined : team.toLowerCase() === 'all' ? '*' : team.toUpperCase(),
    linearApiKey,
    repo,
    defaultBranch: raw.defaultBranch ?? 'main',
    worktreeRoot: expandHome(raw.worktreeRoot ?? `${repo}-worktrees`),
    concurrency: raw.concurrency ?? 3,
    checks: raw.checks ?? [],
    model: raw.model,
    notifications: raw.notifications ?? true,
    stateSync: raw.stateSync ?? true,
    ciAutofix: raw.ciAutofix ?? true,
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
