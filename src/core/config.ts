import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  BASE_CONFIG_PATHS,
  CONTEXT,
  DEFAULT_CONTEXT,
  contextConfigPath,
  listContexts,
} from './context.js';
import { log } from './log.js';
import {
  EXPERIMENTS,
  type CheckConfig,
  type Config,
  type ExperimentName,
  type Guidance,
  type GuidanceScope,
  type RepoConfig,
} from './types.js';

/**
 * Refuse to start, loudly and in writing. The daemon is spawned detached with
 * stdio ignored, so a bare console.error vanishes and the operator sees only
 * "could not reach or start the colinear daemon" with no cause.
 */
function fatal(message: string): never {
  console.error(message);
  log(`fatal: ${message}`);
  process.exit(1);
}

/** the config file this run reads and `:config` edits (context-aware) */
export function configPath(): string {
  return contextConfigPath();
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

type RawConfig = Partial<Config> & {
  repos?: RawRepo[];
  guidance?: RawGuidance;
  prSignoff?: RawText;
  experiments?: RawExperiments;
};

/**
 * Parse a config file. Missing is fine — that's "use the defaults" — but a
 * file that exists and doesn't parse is not: silently falling back would run
 * agents against the default repo with none of your settings.
 */
function readConfigFile(path: string): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch (err) {
    fatal(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export function loadConfig(opts?: { requireKey?: boolean }): Config {
  // guidance is normalized below: a string, a list of lines, or a scope map
  const base = BASE_CONFIG_PATHS.map(readConfigFile).find(Boolean) ?? {};
  let raw: RawConfig = base;

  if (CONTEXT !== DEFAULT_CONTEXT) {
    const path = contextConfigPath();
    const layer = readConfigFile(path);
    if (!layer) {
      fatal(`no context "${CONTEXT}" — expected ${path}\navailable: ${listContexts().join(', ')}`);
    }
    // top-level keys replace wholesale: a context that sets `repos` gets
    // exactly those repos, and one that doesn't inherits the base list
    raw = { ...base, ...layer };
  }

  const linearApiKey = raw.linearApiKey ?? process.env.LINEAR_API_KEY ?? '';
  // chores that never touch Linear (gc) shouldn't demand a key to run — nor
  // should a provider that has no Linear to talk to
  if (!linearApiKey && opts?.requireKey !== false && (raw.provider ?? 'linear') === 'linear') {
    fatal(`No Linear API key. Set LINEAR_API_KEY or add "linearApiKey" to ${configPath()}`);
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
    provider: raw.provider ?? 'linear',
    sqlitePath: raw.sqlitePath ? expandHome(raw.sqlitePath) : undefined,
    demo: raw.demo === true,
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
    guidance: normalizeGuidance(raw.guidance),
    prSignoff: joinLines(raw.prSignoff),
    prSignoffScope: raw.prSignoffScope === 'body' ? 'body' : 'all',
    notifications: raw.notifications ?? true,
    stateSync: raw.stateSync ?? true,
    ciAutofix: raw.ciAutofix ?? true,
    experimental: raw.experimental ?? false,
    experiments: normalizeExperiments(raw.experiments, raw.experimental ?? false),
    autoRebase: raw.autoRebase ?? false,
    autoDispatchSubs: raw.autoDispatchSubs ?? false,
    retentionDays: raw.retentionDays ?? 30,
    worktreeRetentionDays: raw.worktreeRetentionDays ?? 7,
    tickMs: raw.tickMs ?? 1000,
    agentPermissionMode: permissionMode(raw.agentPermissionMode, 'auto'),
    attachPermissionMode: permissionMode(raw.attachPermissionMode, 'auto'),
    denyTools: Array.isArray(raw.denyTools) ? raw.denyTools : [],
    terminal: raw.terminal,
    remote: normalizeRemote(raw.remote),
  };
}

type RawText = string | string[] | undefined;
type RawGuidance = RawText | ({ general?: RawText } & Partial<Record<GuidanceScope, RawText>>);

const joinLines = (v: RawText): string | undefined => (Array.isArray(v) ? v.join('\n') : v);

/**
 * Guidance accepts three shapes, all of which stay readable in JSON: a string,
 * a list of lines, or a map of scopes ({ general, triage, work, review, plan })
 * whose values are themselves a string or a list of lines.
 */
function normalizeGuidance(raw: RawGuidance): Guidance {
  if (!raw) return {};
  if (typeof raw === 'string' || Array.isArray(raw)) return { general: joinLines(raw) };
  const out: Guidance = {};
  for (const scope of ['general', 'triage', 'work', 'review', 'plan'] as const) {
    const text = joinLines(raw[scope]);
    if (text?.trim()) out[scope] = text;
  }
  return out;
}

type RawExperiments = Partial<Record<ExperimentName, boolean>> | ExperimentName[] | undefined;

/**
 * Experiments accept a map or a list of names. An unknown name, or one asked
 * for while the master switch is off, is said out loud: a feature that
 * silently doesn't run is worse than one that refuses to.
 */
function normalizeExperiments(raw: RawExperiments, master: boolean): Partial<Record<ExperimentName, boolean>> {
  const asked = Array.isArray(raw)
    ? Object.fromEntries(raw.map((name) => [name, true]))
    : (raw ?? {});
  const out: Partial<Record<ExperimentName, boolean>> = {};
  for (const [name, on] of Object.entries(asked)) {
    if (!(name in EXPERIMENTS)) {
      log(`config: unknown experiment "${name}" — known: ${Object.keys(EXPERIMENTS).join(', ')}`);
      continue;
    }
    out[name as ExperimentName] = on === true;
  }
  const wanted = Object.entries(out).filter(([, on]) => on);
  if (wanted.length && !master) {
    log(`config: "experimental" is false — ${wanted.map(([n]) => n).join(', ')} stays off`);
  }
  return out;
}

type RawRemote = { ssh?: string; exec?: string[]; label?: string } | undefined;

/**
 * `{ ssh: "vm" }` is the common case and stays writable as such; `exec` is the
 * general form, so docker and kubectl are the same mechanism rather than three
 * special cases in the attach path.
 */
function normalizeRemote(raw: RawRemote): { exec: string[]; label: string } | undefined {
  if (!raw) return undefined;
  if (Array.isArray(raw.exec) && raw.exec.length) {
    return { exec: raw.exec, label: raw.label ?? raw.exec[0] };
  }
  if (raw.ssh) return { exec: ['ssh', '-t', raw.ssh], label: raw.label ?? raw.ssh };
  fatal('config: "remote" needs either { "ssh": "host" } or { "exec": ["cmd", …] }');
}

const PERMISSION_MODES = ['auto', 'acceptEdits', 'default', 'plan', 'dontAsk', 'bypassPermissions'];

/** A typo here would silently widen what agents may do, so it fails loudly. */
function permissionMode(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (!PERMISSION_MODES.includes(raw)) {
    fatal(`unknown permission mode "${raw}" — one of: ${PERMISSION_MODES.join(', ')}`);
  }
  return raw;
}

/** An experiment runs only when the master switch and its own flag agree. */
export function experimentOn(cfg: Config, name: ExperimentName): boolean {
  return cfg.experimental === true && cfg.experiments[name] === true;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}
