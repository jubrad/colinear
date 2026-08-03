import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { CheckConfig, Config, RepoConfig } from './types.js';

const CONFIG_PATHS = [
  join(homedir(), '.config', 'colinear', 'config.json'),
  join(homedir(), '.colinear.json'),
];

/** the config file in use (first existing, else the preferred location) */
export function configPath(): string {
  return CONFIG_PATHS.find((p) => existsSync(p)) ?? CONFIG_PATHS[0];
}

/** Make sure a config file exists to edit — seed it from the resolved config. */
export function ensureConfigFile(cfg: Config): string {
  const path = configPath();
  if (existsSync(path)) return path;
  const seed: Record<string, unknown> = {
    // don't copy the key into a file when it comes from the environment
    ...(process.env.LINEAR_API_KEY ? {} : { linearApiKey: cfg.linearApiKey }),
    repos: cfg.repos.map(({ name, path: repoPath, defaultBranch, worktreeRoot, checks }) => ({
      name,
      path: repoPath,
      defaultBranch,
      worktreeRoot,
      ...(checks.length ? { checks } : {}),
    })),
    concurrency: cfg.concurrency,
    ...(cfg.team ? { team: cfg.team } : {}),
    ...(cfg.model ? { model: cfg.model } : {}),
    notifications: cfg.notifications,
    stateSync: cfg.stateSync,
    ciAutofix: cfg.ciAutofix,
    ...(cfg.terminal ? { terminal: cfg.terminal } : {}),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(seed, null, 2)}\n`);
  return path;
}

interface RawRepo {
  name?: string;
  /** what lives here — triage uses this to route issues to the right repo */
  description?: string;
  path: string;
  defaultBranch?: string;
  remote?: string;
  pushRemote?: string;
  prBase?: string;
  worktreeRoot?: string;
  checks?: CheckConfig[];
}

export function loadConfig(): Config {
  let raw: Partial<Config> & { repos?: RawRepo[] } = {};
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

  // repos allowlist; legacy single-repo fields feed the default entry
  let repos: RepoConfig[] = (raw.repos ?? []).map((r) => {
    const path = expandHome(r.path);
    const defaultBranch = r.defaultBranch ?? 'main';
    return {
      name: r.name ?? basename(path),
      description: r.description,
      path,
      defaultBranch,
      remote: r.remote ?? 'origin',
      pushRemote: r.pushRemote ?? r.remote ?? 'origin',
      prBase: r.prBase ?? defaultBranch,
      worktreeRoot: expandHome(r.worktreeRoot ?? `${path}-worktrees`),
      checks: r.checks ?? [],
    };
  });
  if (!repos.length) {
    const path = expandHome(raw.repo ?? join(homedir(), 'work', 'cloud'));
    repos = [
      {
        name: basename(path),
        path,
        defaultBranch: raw.defaultBranch ?? 'main',
        remote: 'origin',
        pushRemote: 'origin',
        prBase: raw.defaultBranch ?? 'main',
        worktreeRoot: expandHome(raw.worktreeRoot ?? `${path}-worktrees`),
        checks: raw.checks ?? [],
      },
    ];
  }

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
    repos,
    repo: repos[0].path,
    defaultBranch: repos[0].defaultBranch,
    worktreeRoot: repos[0].worktreeRoot,
    checks: repos[0].checks,
    concurrency: raw.concurrency ?? 3,
    model: raw.model,
    notifications: raw.notifications ?? true,
    stateSync: raw.stateSync ?? true,
    ciAutofix: raw.ciAutofix ?? true,
    coordination: raw.coordination ?? false,
    tickMs: raw.tickMs ?? 1000,
    attachPermissionMode: raw.attachPermissionMode ?? 'acceptEdits',
    terminal: raw.terminal,
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
