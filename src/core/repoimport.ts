import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { CONTEXT, DEFAULT_CONTEXT, BASE_CONFIG_PATHS, contextConfigPath } from './context.js';
import { log } from './log.js';
import { repoForSlug, slugsFor } from './reviews.js';
import type { Config, RepoConfig } from './types.js';

const exec = promisify(execFile);

/**
 * `owner/repo` from however it was written: the slug itself, a GitHub URL
 * (a PR's included), or an ssh remote. Undefined for anything else.
 */
export function parseSlug(input: string): string | undefined {
  const text = input.trim().replace(/\.git$/, '');
  const m =
    text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i) ??
    text.match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i) ??
    text.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Where a new clone goes: `cloneRoot` if the config names one, otherwise
 * beside the repos you already have — the directory most of them share.
 */
export function cloneRootFor(cfg: Config): string {
  if (cfg.cloneRoot) return cfg.cloneRoot;
  const parents = cfg.repos.map((r) => dirname(r.path));
  const counts = new Map<string, number>();
  for (const p of parents) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? join(process.env.HOME ?? '.', 'work');
}

/**
 * The file a new repo is written to. The one that defines `repos` for this
 * run: a context's own file when it lists repos (they replace the base list
 * wholesale), otherwise the base config — writing a lone `repos` into a
 * context that inherited them would replace every inherited repo with one.
 */
export function repoConfigFile(): string {
  if (CONTEXT !== DEFAULT_CONTEXT) {
    const own = contextConfigPath();
    if (existsSync(own) && Array.isArray(readJson(own).repos)) return own;
  }
  return BASE_CONFIG_PATHS.find((p) => existsSync(p)) ?? BASE_CONFIG_PATHS[0];
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Append one repo to the config file's `repos`, leaving everything else in it as it was. */
export function addRepoToConfig(path: string, entry: { name: string; path: string; defaultBranch: string; description?: string }): void {
  const raw = readJson(path);
  const repos = Array.isArray(raw.repos) ? (raw.repos as Array<Record<string, unknown>>) : [];
  if (repos.some((r) => r.path === entry.path)) return;
  raw.repos = [...repos, { name: entry.name, ...(entry.description ? { description: entry.description } : {}), path: entry.path, defaultBranch: entry.defaultBranch }];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

export interface ImportResult {
  repo: RepoConfig;
  /** what happened, for a toast: cloned, found already on disk, or already configured */
  how: 'configured' | 'found' | 'cloned';
  path: string;
}

/**
 * Make a GitHub repo one colinear can work in: clone it next to the others
 * (or find the clone already there) and add it to the config's `repos`.
 *
 * Only ever on the operator's say-so — `r` on a review of a repo you have not
 * got, or "clone from GitHub" in custom dispatch. Nothing is pushed or posted:
 * a clone reads GitHub, and the config is a local file. `reload` is how the
 * caller re-reads the config afterwards, so the repo it hands back is the one
 * the rest of colinear now sees, defaults filled in.
 */
export async function importRepo(cfg: Config, slug: string, reload: () => void, opts: { file?: string } = {}): Promise<ImportResult> {
  const known = await repoForSlug(cfg, slug);
  if (known) return { repo: known, how: 'configured', path: known.path };

  const [owner, name] = slug.split('/');
  const root = cloneRootFor(cfg);
  const taken = new Set(cfg.repos.map((r) => r.name.toLowerCase()));
  const repoName = taken.has(name.toLowerCase()) ? `${owner}-${name}` : name;
  let target = join(root, name);
  let how: ImportResult['how'] = 'cloned';
  if (existsSync(target)) {
    // a clone already on disk that the config never named: use it as it is
    const remotes = await slugsFor({ name, path: target } as RepoConfig);
    if (remotes.includes(slug.toLowerCase())) how = 'found';
    else target = join(root, `${owner}-${name}`);
  }
  if (how === 'cloned' && existsSync(target)) {
    const remotes = await slugsFor({ name, path: target } as RepoConfig);
    if (!remotes.includes(slug.toLowerCase())) throw new Error(`${target} exists and is not a clone of ${slug}`);
    how = 'found';
  }
  if (how === 'cloned') {
    mkdirSync(root, { recursive: true });
    log(`import: cloning ${slug} into ${target}`);
    await exec('gh', ['repo', 'clone', slug, target], { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 }).catch((err: unknown) => {
      throw new Error(`could not clone ${slug}: ${String((err as { stderr?: string })?.stderr ?? err).trim().slice(0, 200)}`);
    });
  }

  // the branch work starts from, and a description triage can route issues by
  let defaultBranch = 'main';
  let description: string | undefined;
  try {
    const { stdout } = await exec('gh', ['repo', 'view', slug, '--json', 'defaultBranchRef,description']);
    const info = JSON.parse(stdout) as { defaultBranchRef?: { name?: string }; description?: string };
    defaultBranch = info.defaultBranchRef?.name || defaultBranch;
    description = info.description?.trim() || undefined;
  } catch (err) {
    log(`import: could not read ${slug}'s default branch, assuming main: ${String(err).slice(0, 120)}`);
  }

  const file = opts.file ?? repoConfigFile();
  addRepoToConfig(file, { name: repoName, path: target, defaultBranch, description });
  log(`import: ${slug} added to ${file} as ${repoName}`);
  reload();
  const repo = cfg.repos.find((r) => r.path === target);
  if (!repo) throw new Error(`${slug} was written to ${file} but the reloaded config does not have it`);
  return { repo, how, path: target };
}
