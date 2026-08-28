import { execFile } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { CONFIG_DIR, DEFAULT_CONTEXT, contextConfigPath, listContexts, stateDirFor } from './context.js';
import { decryptBackup, encryptBackup, isEncryptedBackup } from './backupcrypt.js';
import { transcriptDir } from './transcripts.js';
import type { Config } from './types.js';

const exec = promisify(execFile);

/**
 * Move a colinear installation to another machine.
 *
 * The expensive half of colinear is not its state file — it is the *work in
 * progress*: a dozen worktrees with uncommitted changes, and the Claude Code
 * transcripts that let `r` and `c` pick a conversation back up. Losing those
 * to a new laptop means every in-flight task starts over.
 *
 * ## What a backup is
 *
 * A gzipped tar of four things, in this order of irreplaceability:
 *
 * - **transcripts** — the conversations, keyed by the directory they happened
 *   in (that is Claude Code's own rule, not ours);
 * - **worktrees** — as a git bundle of the commits that are not upstream, a
 *   patch of what is uncommitted, and a tar of what is untracked. Not as a
 *   directory copy;
 * - **state** — the store snapshot, plans, channels, per context;
 * - **config** — every context's config file.
 *
 * ## Why worktrees are not copied
 *
 * A worktree is not a self-contained directory: its `.git` is a *file*
 * pointing into the parent repository's administrative area, so a copied one
 * is inert on the far side. Recording it as (bundle, patch, untracked) instead
 * is both correct — `git worktree add` on the new machine produces a real,
 * registered worktree — and dramatically smaller, because git already knows
 * which files do not belong in it. `target/`, `.venv/`, `node_modules/` and
 * every other build artefact are excluded for free by `--exclude-standard`,
 * which beats any list this file could carry: it is the exclusion the
 * repository itself declares.
 *
 * The two exceptions are colinear's own scratch files (the review document and
 * the subtask list). They are in `.git/info/exclude` precisely so no agent
 * commits them, which also means git would not have offered them here — they
 * are added back by name, because a review's findings are not a build
 * artefact.
 *
 * ## What it does not carry
 *
 * The repositories. A clone of a monorepo dwarfs everything above and is one
 * command to recreate; the manifest records each one's remote URL so restore
 * can tell you exactly what to run, or run it for you with `--clone`.
 */

/** Bumped when the archive layout changes in a way an older restore misreads. */
export const BACKUP_FORMAT = 1;

export const COLINEAR_SCRATCH = ['.colinear-review.md', '.colinear-subtasks.md'];

/** State-dir entries that are either live process state or rebuildable noise. */
const STATE_SKIP = [/^coli\.sock$/, /^coli\.pid$/, /^colinear\.log$/, /^attach-.*\.sh$/, /\.tmp$/];

export interface WorktreeRecord {
  /** where it lived, absolute, on the machine it came from */
  path: string;
  /** the repo it belongs to, by config name — the far side resolves the path */
  repo: string;
  branch: string;
  head: string;
  /** the upstream commit the branch grew from; the bundle's prerequisite */
  base?: string;
  /** commits in the bundle; 0 means the branch is level with base */
  commits: number;
  dirtyFiles: number;
  untrackedFiles: number;
  /** untracked files skipped for being over the size cap */
  skipped: string[];
  bytes: number;
}

export interface Manifest {
  format: number;
  colinear: string;
  createdAt: string;
  host: string;
  platform: string;
  home: string;
  contexts: Array<{ name: string; configPath: string; stateDir: string }>;
  repos: Array<{ name: string; path: string; remoteUrl?: string; defaultBranch: string; worktreeRoot: string }>;
  worktrees: WorktreeRecord[];
  /** transcript directories, by the cwd they belong to */
  transcripts: Array<{ cwd: string; dir: string; sessions: number }>;
  notes: string[];
}

export interface BackupOptions {
  out?: string;
  version: string;
  /**
   * Encrypt with this passphrase. Absent means an unencrypted archive, which
   * the CLI only allows when asked for outright — a backup carries every
   * context's API key and every conversation an agent has had.
   */
  passphrase?: string;
  /** skip the worktree capture entirely — state and conversations only */
  noWorktrees?: boolean;
  /** untracked files larger than this are named in the manifest, not carried */
  maxFileMb?: number;
  onProgress?: (line: string) => void;
}

export interface RestoreOptions {
  archive: string;
  version: string;
  /** required for an encrypted archive; ignored for a plain one */
  passphrase?: string;
  dryRun?: boolean;
  /** clone any repository whose path is missing, from its recorded remote */
  clone?: boolean;
  onProgress?: (line: string) => void;
}

const MB = 1024 * 1024;

/**
 * `coli-backup-<host>-<yyyy-mm-dd-hhmm>.tar.gz` in the working directory,
 * `.tar.gz.enc` when it is encrypted — which is the default. The suffix is
 * not decoration: an encrypted archive is not a tarball, and `tar -tzf` on
 * one should fail with something better than a parse error.
 */
export function defaultBackupName(now = new Date(), encrypted = true): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `coli-backup-${hostSlug()}-${stamp}.tar.gz${encrypted ? '.enc' : ''}`;
}

function hostSlug(): string {
  return (process.env.HOSTNAME ?? hostname())
    .split('.')[0]
    .replace(/[^\w-]/g, '-')
    .slice(0, 24);
}

/* ------------------------------------------------------------------ backup */

export async function createBackup(cfg: Config, opts: BackupOptions): Promise<{ path: string; manifest: Manifest }> {
  const say = opts.onProgress ?? (() => {});
  const out = opts.out ?? join(process.cwd(), defaultBackupName(new Date(), Boolean(opts.passphrase)));
  const staging = mkdtempSync(join(tmpdir(), 'coli-backup-'));
  const maxBytes = (opts.maxFileMb ?? 64) * MB;

  try {
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      colinear: opts.version,
      createdAt: new Date().toISOString(),
      host: hostSlug(),
      platform: process.platform,
      home: homedir(),
      contexts: [],
      repos: [],
      worktrees: [],
      transcripts: [],
      notes: [],
    };

    // ── config and state, per context ────────────────────────────────────
    for (const name of listContexts()) {
      const configPath = contextConfigPath(name);
      const stateDir = stateDirFor(name);
      if (!existsSync(configPath)) continue;
      manifest.contexts.push({ name, configPath, stateDir });
      copyFile(configPath, join(staging, 'config', `${name}.json`));
      if (existsSync(stateDir)) copyStateDir(stateDir, join(staging, 'state', name));
      say(`config + state: ${name}`);
    }

    // ── the repositories we know about, so restore can find or clone them ─
    for (const repo of cfg.repos) {
      manifest.repos.push({
        name: repo.name,
        path: repo.path,
        remoteUrl: await remoteUrl(repo.path, repo.remote ?? 'origin'),
        defaultBranch: repo.defaultBranch,
        worktreeRoot: repo.worktreeRoot,
      });
    }

    // ── worktrees ────────────────────────────────────────────────────────
    if (!opts.noWorktrees) {
      let index = 0;
      for (const wt of discoverWorktrees(cfg)) {
        const slot = join(staging, 'worktrees', String(index));
        const record = await captureWorktree(wt, slot, maxBytes, say);
        if (record) {
          manifest.worktrees.push(record);
          index++;
        } else {
          rmSync(slot, { recursive: true, force: true });
        }
      }
    } else {
      manifest.notes.push('worktrees were not captured (--no-worktrees)');
    }

    // ── conversations ────────────────────────────────────────────────────
    // Every directory a session could have happened in: the worktrees above,
    // and the repositories themselves for anything run in place.
    const cwds = new Set<string>([...manifest.worktrees.map((w) => w.path), ...cfg.repos.map((r) => r.path)]);
    for (const cwd of cwds) {
      const dir = transcriptDir(cwd);
      if (!existsSync(dir)) continue;
      const sessions = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length;
      if (!sessions) continue;
      copyTree(dir, join(staging, 'transcripts', basename(dir)));
      manifest.transcripts.push({ cwd, dir, sessions });
    }
    say(`conversations: ${manifest.transcripts.reduce((n, t) => n + t.sessions, 0)} transcripts`);

    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    mkdirSync(dirname(out), { recursive: true });
    if (opts.passphrase) {
      // its own directory, not `staging`: tar would otherwise archive the
      // plaintext into itself, and the plaintext must not outlive this call
      const work = mkdtempSync(join(tmpdir(), 'coli-backup-plain-'));
      try {
        const plain = join(work, 'archive.tar.gz');
        await tarCreate(staging, plain);
        await encryptBackup(plain, out, opts.passphrase);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      say(`encrypted ${out} (${formatBytes(statSync(out).size)})`);
    } else {
      await tarCreate(staging, out);
      say(`wrote ${out} (${formatBytes(statSync(out).size)}, NOT encrypted)`);
    }
    return { path: out, manifest };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Every checkout under a configured worktree root, with the repo it belongs to. */
function discoverWorktrees(cfg: Config): Array<{ path: string; repo: Config['repos'][number] }> {
  const found: Array<{ path: string; repo: Config['repos'][number] }> = [];
  for (const repo of cfg.repos) {
    if (!existsSync(repo.worktreeRoot)) continue;
    for (const name of readdirSync(repo.worktreeRoot)) {
      const path = join(repo.worktreeRoot, name);
      try {
        if (!statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(path, '.git'))) continue;
      found.push({ path, repo });
    }
  }
  return found;
}

async function captureWorktree(
  wt: { path: string; repo: Config['repos'][number] },
  slot: string,
  maxBytes: number,
  say: (line: string) => void,
): Promise<WorktreeRecord | undefined> {
  const { path, repo } = wt;
  const head = await git(path, ['rev-parse', 'HEAD']);
  if (!head) {
    say(`skipped ${basename(path)} — no HEAD (an empty or broken checkout)`);
    return undefined;
  }
  const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])) || 'HEAD';
  const remote = repo.remote ?? 'origin';
  const base = await git(path, ['merge-base', 'HEAD', `${remote}/${repo.defaultBranch}`]);

  mkdirSync(slot, { recursive: true });
  let commits = 0;
  if (base && base !== head) {
    // Only what is not upstream. The prerequisite travels inside the bundle,
    // so git itself refuses to unpack it into a repository that lacks the
    // base — a much better failure than a silently detached branch.
    const args = ['bundle', 'create', join(slot, 'commits.bundle'), `${base}..HEAD`];
    if (await gitOk(path, args)) {
      commits = Number.parseInt((await git(path, ['rev-list', '--count', `${base}..HEAD`])) || '0', 10);
    }
  }

  // --binary so a changed image or fixture survives the round trip
  const patch = await gitRaw(path, ['diff', 'HEAD', '--binary']);
  if (patch.trim()) writeFileSync(join(slot, 'dirty.patch'), patch);
  const dirtyFiles = ((await git(path, ['diff', 'HEAD', '--name-only'])) ?? '').split('\n').filter(Boolean).length;

  // untracked, minus everything the repository declares uninteresting — which
  // is where target/, .venv/ and node_modules/ go — plus colinear's own
  // scratch files, which are excluded for a different reason entirely
  const listed = (await git(path, ['ls-files', '--others', '--exclude-standard'])) ?? '';
  const untracked = listed.split('\n').filter(Boolean);
  for (const file of COLINEAR_SCRATCH) if (existsSync(join(path, file))) untracked.push(file);

  const skipped: string[] = [];
  const carry: string[] = [];
  for (const file of untracked) {
    let size = 0;
    try {
      size = statSync(join(path, file)).size;
    } catch {
      continue;
    }
    if (size > maxBytes) skipped.push(`${file} (${formatBytes(size)})`);
    else carry.push(file);
  }
  if (carry.length) await tarFiles(path, carry, join(slot, 'untracked.tar'));

  const record: WorktreeRecord = {
    path,
    repo: repo.name,
    branch,
    head,
    base: base || undefined,
    commits,
    dirtyFiles,
    untrackedFiles: carry.length,
    skipped,
    bytes: dirSize(slot),
  };
  writeFileSync(join(slot, 'meta.json'), `${JSON.stringify(record, null, 2)}\n`);
  say(
    `worktree ${basename(path)}: ${commits} commit${commits === 1 ? '' : 's'}, ` +
      `${record.dirtyFiles} modified, ${carry.length} untracked (${formatBytes(record.bytes)})` +
      (skipped.length ? ` — ${skipped.length} over the size cap` : ''),
  );
  return record;
}

/* ----------------------------------------------------------------- restore */

export interface RestorePlanItem {
  what: string;
  detail: string;
  blocked?: string;
}

export async function restoreBackup(opts: RestoreOptions): Promise<RestorePlanItem[]> {
  const say = opts.onProgress ?? (() => {});
  const staging = mkdtempSync(join(tmpdir(), 'coli-restore-'));
  const done: RestorePlanItem[] = [];
  try {
    await tarExtract(opts.archive, staging, opts.passphrase);
    const manifest = JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as Manifest;

    if (manifest.format !== BACKUP_FORMAT) {
      throw new Error(
        `this archive is format ${manifest.format}; this colinear reads ${BACKUP_FORMAT}. ` +
          'Restore it with the version that wrote it.',
      );
    }
    if (manifest.colinear !== opts.version) {
      throw new Error(
        `this archive was written by colinear ${manifest.colinear}; you are running ${opts.version}. ` +
          'Restore is only supported from the same version — check out that tag, or rebuild.',
      );
    }
    if (manifest.platform !== process.platform) {
      throw new Error(
        `this archive came from ${manifest.platform} and you are on ${process.platform}. ` +
          'Worktree patches and transcripts assume the same OS.',
      );
    }

    // The one thing that genuinely differs between two machines: where home
    // is. Every absolute path in the archive — config, state, worktrees, and
    // the *encoding* of a transcript directory — is rewritten through this.
    const rehome = (p: string) => (p.startsWith(manifest.home) ? join(homedir(), relative(manifest.home, p)) : p);
    const moved = manifest.home !== homedir();
    if (moved) say(`home moved: ${manifest.home} → ${homedir()} — paths will be rewritten`);

    // ── config ───────────────────────────────────────────────────────────
    for (const ctx of manifest.contexts) {
      const src = join(staging, 'config', `${ctx.name}.json`);
      if (!existsSync(src)) continue;
      const target = ctx.name === DEFAULT_CONTEXT ? join(CONFIG_DIR, 'config.json') : rehome(ctx.configPath);
      const body = moved ? rewritePaths(readFileSync(src, 'utf8'), manifest.home, homedir()) : readFileSync(src, 'utf8');
      done.push({ what: 'config', detail: `${ctx.name} → ${target}` });
      if (!opts.dryRun) {
        keepExisting(target);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
      }
    }

    // ── state ────────────────────────────────────────────────────────────
    for (const ctx of manifest.contexts) {
      const src = join(staging, 'state', ctx.name);
      if (!existsSync(src)) continue;
      const target = stateDirFor(ctx.name);
      done.push({ what: 'state', detail: `${ctx.name} → ${target}` });
      if (opts.dryRun) continue;
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(src)) {
        const to = join(target, entry);
        keepExisting(to);
        copyTree(join(src, entry), to);
      }
      // the store snapshot holds worktree paths, and a plan or a channel can
      // name one in prose; they all have to point at this machine's disk or
      // the board comes back referring to a directory that is not there
      if (moved) rewriteTree(target, manifest.home, homedir());
    }

    // ── conversations ────────────────────────────────────────────────────
    // The directory name *is* the cwd, encoded. A moved home means every one
    // of them is filed under a name that no longer describes anywhere, so
    // they are re-encoded from the rewritten path rather than copied as-is.
    for (const t of manifest.transcripts) {
      const src = join(staging, 'transcripts', basename(t.dir));
      if (!existsSync(src)) continue;
      const target = transcriptDir(rehome(t.cwd));
      done.push({
        what: 'conversations',
        detail: `${t.sessions} from ${basename(t.cwd)} → ${target}${moved ? ' (paths rewritten)' : ''}`,
      });
      if (opts.dryRun) continue;
      copyTree(src, target, { merge: true });
      // The directory name is only half of it. Every record in a transcript
      // carries the absolute directory it happened in — and the absolute path
      // of every file that was read or written, and every command that named
      // one. A conversation restored under the right name but still claiming
      // to have happened in another user's home is a conversation about files
      // that do not exist.
      if (moved) rewriteTree(target, manifest.home, homedir());
    }

    // ── repositories ─────────────────────────────────────────────────────
    const repoPath = new Map<string, string>();
    for (const repo of manifest.repos) {
      const path = rehome(repo.path);
      if (existsSync(join(path, '.git'))) {
        repoPath.set(repo.name, path);
        continue;
      }
      if (opts.clone && repo.remoteUrl) {
        done.push({ what: 'clone', detail: `${repo.remoteUrl} → ${path}` });
        if (!opts.dryRun) {
          mkdirSync(dirname(path), { recursive: true });
          await exec('git', ['clone', repo.remoteUrl, path], { maxBuffer: 32 * MB });
          repoPath.set(repo.name, path);
        }
        continue;
      }
      done.push({
        what: 'repo',
        detail: repo.name,
        blocked: repo.remoteUrl
          ? `not at ${path} — clone it (git clone ${repo.remoteUrl} ${path}) or re-run with --clone`
          : `not at ${path}, and the backup recorded no remote for it`,
      });
    }

    // ── worktrees ────────────────────────────────────────────────────────
    for (const [i, wt] of manifest.worktrees.entries()) {
      const slot = join(staging, 'worktrees', String(i));
      const target = rehome(wt.path);
      const repo = repoPath.get(wt.repo);
      if (!repo) {
        done.push({ what: 'worktree', detail: basename(target), blocked: `${wt.repo} is not on this machine` });
        continue;
      }
      if (existsSync(target)) {
        done.push({ what: 'worktree', detail: basename(target), blocked: 'already exists — left alone' });
        continue;
      }
      done.push({
        what: 'worktree',
        detail: `${basename(target)} (${wt.commits} commits, ${wt.dirtyFiles} modified, ${wt.untrackedFiles} untracked)`,
      });
      if (opts.dryRun) continue;
      try {
        await rebuildWorktree(repo, target, wt, slot);
        say(`restored ${basename(target)}`);
      } catch (err) {
        done[done.length - 1].blocked = String(err).slice(0, 160);
      }
    }

    return done;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function rebuildWorktree(repo: string, target: string, wt: WorktreeRecord, slot: string): Promise<void> {
  const bundle = join(slot, 'commits.bundle');
  // the bundle carries its own prerequisite, so an unfetched base fails here
  // rather than producing a branch that quietly lost its history
  if (existsSync(bundle)) {
    await exec('git', ['-C', repo, 'fetch', bundle, `+HEAD:refs/heads/${wt.branch}`], { maxBuffer: 64 * MB });
  } else if (wt.base) {
    await exec('git', ['-C', repo, 'branch', '-f', wt.branch, wt.base], { maxBuffer: 4 * MB });
  }
  mkdirSync(dirname(target), { recursive: true });
  await exec('git', ['-C', repo, 'worktree', 'add', target, wt.branch], { maxBuffer: 32 * MB });

  const patch = join(slot, 'dirty.patch');
  if (existsSync(patch)) {
    await exec('git', ['-C', target, 'apply', '--whitespace=nowarn', patch], { maxBuffer: 64 * MB });
  }
  const untracked = join(slot, 'untracked.tar');
  if (existsSync(untracked)) await exec('tar', ['-xf', untracked, '-C', target], { maxBuffer: 32 * MB });
}

/* ------------------------------------------------------------------- plumbing */

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * MB });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * Did it work — as opposed to what did it say. `git bundle create` prints to
 * stderr and leaves stdout empty, so asking the string form whether it
 * succeeded reads every success as a failure.
 */
async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * MB });
    return true;
  } catch {
    return false;
  }
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 256 * MB });
    return stdout;
  } catch {
    return '';
  }
}

async function remoteUrl(repoPath: string, remote: string): Promise<string | undefined> {
  return (await git(repoPath, ['remote', 'get-url', remote])) || undefined;
}

/** tar the whole staging directory, gzipped, with the archive rooted at `.`. */
async function tarCreate(from: string, out: string): Promise<void> {
  const tmp = `${out}.part`;
  await exec('tar', ['-cf', tmp, '-C', from, '.'], { maxBuffer: 32 * MB });
  await pipeline(createReadStream(tmp), createGzip({ level: 9 }), createWriteStream(out));
  rmSync(tmp, { force: true });
}

async function tarExtract(archive: string, into: string, passphrase?: string): Promise<void> {
  const tmp = join(into, '.archive.tar');
  await pipeline(createReadStream(await plaintextArchive(archive, into, passphrase)), createGunzip(), createWriteStream(tmp));
  await exec('tar', ['-xf', tmp, '-C', into], { maxBuffer: 32 * MB });
  rmSync(tmp, { force: true });
}

/**
 * The path of a readable `.tar.gz` for this archive — itself when it is one,
 * a decrypted copy inside `work` when it is not.
 *
 * Both readers go through here, so `--list` and a real restore agree about
 * what a passphrase is for, and neither can be taught to read an encrypted
 * archive without the other.
 */
async function plaintextArchive(archive: string, work: string, passphrase?: string): Promise<string> {
  if (!isEncryptedBackup(archive)) return archive;
  if (!passphrase) {
    throw new Error(
      `${basename(archive)} is encrypted — restore it with the passphrase it was made with ` +
        '(--passphrase-file FILE, or COLINEAR_BACKUP_PASSPHRASE).',
    );
  }
  const plain = join(work, '.archive.decrypted.tar.gz');
  await decryptBackup(archive, plain, passphrase);
  return plain;
}

/** tar a named list of files, given relative to `cwd`, without compressing. */
async function tarFiles(cwd: string, files: string[], out: string): Promise<void> {
  // a list file, because a few thousand untracked paths overflow argv
  const listPath = `${out}.list`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(listPath, `${files.join('\n')}\n`);
  await exec('tar', ['-cf', out, '-C', cwd, '-T', listPath], { maxBuffer: 32 * MB });
  rmSync(listPath, { force: true });
}

function copyFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, readFileSync(from));
}

/**
 * Copy a file or a directory. `merge` keeps whatever is already at the
 * destination and adds what is missing — transcripts restore that way, because
 * a session recorded on this machine since the backup is not the archive's to
 * overwrite.
 */
function copyTree(from: string, to: string, opts?: { merge?: boolean }): void {
  const stat = statSync(from);
  if (!stat.isDirectory()) {
    if (opts?.merge && existsSync(to)) return;
    return copyFile(from, to);
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) copyTree(join(from, entry), join(to, entry), opts);
}

/** The state dir minus the socket, the pidfile, the log and the attach scripts. */
function copyStateDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (STATE_SKIP.some((re) => re.test(entry))) continue;
    // contexts/ under the default state dir holds the *other* contexts, which
    // are backed up in their own right
    if (entry === 'contexts') continue;
    copyTree(join(from, entry), join(to, entry));
  }
}

/** Never overwrite in place: the previous file moves aside, named and dated. */
function keepExisting(path: string): void {
  if (!existsSync(path)) return;
  const aside = `${path}.before-restore`;
  rmSync(aside, { recursive: true, force: true });
  renameSync(path, aside);
}

/**
 * Repoint absolute paths at this machine's home.
 *
 * Textual on purpose: config and state are both JSON, the old home is an
 * unambiguous absolute prefix, and walking every schema to find the fields
 * that happen to hold a path is how one gets missed.
 */
export function rewritePaths(text: string, oldHome: string, newHome: string): string {
  if (oldHome === newHome) return text;
  return text.split(JSON.stringify(oldHome).slice(1, -1)).join(JSON.stringify(newHome).slice(1, -1));
}

/** Extensions we will rewrite. Anything else is left byte-for-byte. */
const TEXT_FILES = ['.json', '.jsonl', '.md', '.txt'];

/**
 * Repoint every path in a tree, and say how many files moved.
 *
 * By extension rather than by sniffing: a git bundle and an sqlite database
 * both live under here, and a "does this look like text" heuristic that is
 * wrong once corrupts one of them. The list is short because the things that
 * need rewriting are all things colinear or Claude Code wrote as JSON.
 */
function rewriteTree(dir: string, oldHome: string, newHome: string): number {
  if (oldHome === newHome || !existsSync(dir)) return 0;
  let changed = 0;
  const walk = (path: string) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (!TEXT_FILES.some((ext) => path.endsWith(ext))) return;
    const before = readFileSync(path, 'utf8');
    const after = rewritePaths(before, oldHome, newHome);
    if (after !== before) {
      writeFileSync(path, after);
      changed++;
    }
  };
  walk(dir);
  return changed;
}

function dirSize(path: string): number {
  let total = 0;
  const walk = (p: string) => {
    let stat;
    try {
      stat = statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else total += stat.size;
  };
  walk(path);
  return total;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(1)}G`;
  if (bytes >= MB) return `${Math.round(bytes / MB)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/** Read a manifest without unpacking the rest — `coli restore --list`. */
export async function readManifest(archive: string, passphrase?: string): Promise<Manifest> {
  const staging = mkdtempSync(join(tmpdir(), 'coli-manifest-'));
  try {
    const tmp = join(staging, 'a.tar');
    const source = await plaintextArchive(archive, staging, passphrase);
    await pipeline(createReadStream(source), createGunzip(), createWriteStream(tmp));
    await exec('tar', ['-xf', tmp, '-C', staging, './manifest.json'], { maxBuffer: 8 * MB });
    return JSON.parse(readFileSync(join(staging, 'manifest.json'), 'utf8')) as Manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
