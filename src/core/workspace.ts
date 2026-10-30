import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, watch as watchFs } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from './types.js';
import { recoveryNote, worktreeForBranch } from './worktrees.js';

const exec = promisify(execFile);

/**
 * A worktree, and the things the daemon does in it.
 *
 * The daemon used to reach into worktrees directly — `execFile` with a cwd,
 * `readFileSync` on a joined path — in a dozen places. That only works while
 * the worktree is on the daemon's own disk. Going through this interface is
 * what lets the same code drive a worktree somewhere else: in a container, or
 * in a pod in a cluster, where a runner answers these calls
 * (design/multi-user/runner.md).
 *
 * Paths given to it are relative to the worktree, and one that climbs out is
 * refused rather than resolved: a runner serving these calls must not become
 * a way to read the rest of its machine.
 */
export interface Workspace {
  /** the worktree as its own side sees it: what prompts and an agent's cwd use */
  readonly path: string;
  /** never throws for a command that ran and failed; `code` says how it went */
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  /** undefined when the file isn't there */
  readFile(rel: string): Promise<string | undefined>;
  /** atomic: written beside the target, then renamed over it */
  writeFile(rel: string, content: string): Promise<void>;
  exists(rel: string): Promise<boolean>;
  /**
   * Call `onChange` when the file changes, including when it first appears.
   * Returns the way to stop. Bursts are the caller's to smooth over: editors
   * and agents write in several steps.
   */
  watch(rel: string, onChange: () => void): () => void;
}

export interface ExecOpts {
  /** relative to the worktree */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
  signal?: AbortSignal;
  /** keep at most this many characters of each stream (the tail); default 1 MB */
  maxOutput?: number;
}

export interface ExecResult {
  /** the exit code; -1 when the command could not start, timed out, or was aborted */
  code: number;
  stdout: string;
  stderr: string;
  /** stdout and stderr interleaved as they arrived, tail-capped like each stream */
  output: string;
  /** some output was dropped from the front to stay under `maxOutput` */
  truncated: boolean;
}

const MAX_OUTPUT = 1024 * 1024;

/** `rel` inside `root`, or an error if it would land anywhere else. */
export function inside(root: string, rel: string): string {
  const full = resolve(root, rel);
  const back = relative(root, full);
  if (back.startsWith('..') || isAbsolute(back)) throw new Error(`${rel} is outside the worktree`);
  return full;
}

/** A worktree on this machine: today's behaviour, behind the interface. */
export function localWorkspace(path: string): Workspace {
  return {
    path,
    exec: (argv, opts = {}) => localExec(path, argv, opts),
    readFile: async (rel) => {
      const file = inside(path, rel);
      return existsSync(file) ? readFile(file, 'utf8') : undefined;
    },
    writeFile: async (rel, content) => {
      const file = inside(path, rel);
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, content);
      await rename(tmp, file);
    },
    exists: async (rel) => existsSync(inside(path, rel)),
    watch: (rel, onChange) => {
      const file = inside(path, rel);
      // the directory, not the file: the file may not exist until something writes it
      const watcher = watchFs(dirname(file), (_event, name) => {
        if (name === basename(file)) onChange();
      });
      watcher.unref();
      return () => watcher.close();
    },
  };
}

function localExec(root: string, argv: string[], opts: ExecOpts): Promise<ExecResult> {
  const cap = opts.maxOutput ?? MAX_OUTPUT;
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let truncated = false;
    const keep = (buf: string, chunk: string): string => {
      const next = buf + chunk;
      if (next.length <= cap) return next;
      truncated = true;
      return next.slice(-cap);
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd: opts.cwd ? inside(root, opts.cwd) : root,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts.timeoutMs,
        signal: opts.signal,
      });
    } catch (err) {
      done({ code: -1, stdout, stderr: String(err), output: String(err), truncated });
      return;
    }
    child.stdout.on('data', (c: Buffer) => {
      stdout = keep(stdout, c.toString());
      output = keep(output, c.toString());
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = keep(stderr, c.toString());
      output = keep(output, c.toString());
    });
    let failed: string | undefined;
    child.on('error', (err) => {
      failed = String(err);
    });
    child.on('close', (code) => {
      if (failed !== undefined) {
        output = keep(output, output ? `\n${failed}` : failed);
        done({ code: -1, stdout, stderr: stderr || failed, output, truncated });
        return;
      }
      done({ code: code ?? -1, stdout, stderr, output, truncated });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** What a review's worktree is cut from: the pull request's head, on a branch of ours. */
export interface ReviewWorktreeSpec {
  number: number;
  /** owner/name, to find the right remote */
  repository: string;
  head: string;
  base: string;
  repo: { path: string; worktreeRoot: string };
  scratch: string[];
}

/** What a task's worktree is cut from. */
export interface TaskWorktreeSpec {
  /** the identifier the worktree directory is named after */
  name: string;
  branch: string;
  /** adopt an existing PR: check out its head branch instead of a fresh one */
  adopt?: boolean;
  repo: { path: string; defaultBranch: string; remote?: string; pushRemote?: string; worktreeRoot: string };
  /** files colinear writes in a worktree that must never be committed */
  scratch: string[];
}

/**
 * Where worktrees come from.
 *
 * Local: `git worktree add` off the repo's main checkout, as colinear always
 * has. A cluster's provider creates a workspace for the operator to schedule
 * and has its runner clone into it instead, and hands back the same
 * interface.
 */
export interface WorkspaceProvider {
  /** a task's worktree, created or found; `note` says what had to be repaired on the way */
  ensureTask(spec: TaskWorktreeSpec, note?: (line: string) => void): Promise<{ workspace: Workspace; branch: string }>;
  /** a review's checkout of a pull request, made or brought up to its head; `note` narrates it */
  ensureReview(spec: ReviewWorktreeSpec, note?: (line: string) => void): Promise<Workspace>;
  /** one that already exists, by the path a task recorded */
  open(path: string): Workspace;
  /** gone for good, with the branch colinear made for it, if any */
  remove(spec: { repoPath: string; path: string; branch?: string }): Promise<void>;
}

/**
 * The provider a config's daemon uses. One place to answer it, so the module-level
 * code (self-review, gc) and the long-lived classes (dispatcher, reviewer)
 * can't disagree about where a worktree lives. Local until a runner exists.
 */
export function workspacesFor(_cfg: Config): WorkspaceProvider {
  return localWorkspaces;
}

export const localWorkspaces: WorkspaceProvider = {
  open: localWorkspace,
  async remove({ repoPath, path, branch }) {
    if (existsSync(path)) await exec('git', ['-C', repoPath, 'worktree', 'remove', '--force', path]);
    await exec('git', ['-C', repoPath, 'worktree', 'prune']).catch(() => {});
    if (branch) await exec('git', ['-C', repoPath, 'branch', '-D', branch]).catch(() => {});
  },
  async ensureReview(spec, note = () => {}) {
    const { repo } = spec;
    const worktree = join(repo.worktreeRoot, `review-${spec.number}`);
    const branch = `review/${spec.number}`;
    const remote = await remoteFor(repo.path, spec.repository);

    // The head branch of a fork's PR does not exist on the base repository, so
    // fetching `<remote>/<branch>` fails and takes the whole review with it —
    // and no amount of adding the contributor's remote helps, because the
    // branch is then under *their* name, not the one the PR reports. GitHub
    // publishes every PR's head on the BASE repo as refs/pull/<n>/head, fork
    // or not, so that is what colinear fetches: one ref, one code path, no
    // remotes to keep in step with whoever opened the PR.
    const prRef = `refs/remotes/${remote}/pr/${spec.number}`;
    note(`fetching pull/${spec.number}/head from ${remote}…`);
    const viaPullRef = await exec('git', ['-C', repo.path, 'fetch', remote, `+refs/pull/${spec.number}/head:${prRef}`]).then(
      () => true,
      () => false,
    );
    let source = prRef;
    if (!viaPullRef) {
      // not GitHub, or the ref is not published: fall back to the branch name,
      // which is right for a same-repo PR and the best available guess otherwise
      note(`pull/${spec.number}/head unavailable — trying the branch ${spec.head}`);
      await exec('git', ['-C', repo.path, 'fetch', remote, `${spec.head}:refs/remotes/${remote}/${spec.head}`]).catch(() =>
        exec('git', ['-C', repo.path, 'fetch', remote]).catch(() => {}),
      );
      source = `${remote}/${spec.head}`;
    }
    // the base is needed too: it is what the diff is taken against
    await exec('git', ['-C', repo.path, 'fetch', remote, spec.base]).catch(() => {});

    if (existsSync(worktree)) {
      note(`reusing worktree ${worktree}`);
      for (const path of clearBrokenSubmodules(worktree)) note(`cleared a half-initialised submodule at ${path}`);
      // --force because a review checkout is scratch: it tracks the pull
      // request and holds nothing of the operator's. Without it, a run that
      // died partway through updating the tree leaves modifications that
      // refuse every later checkout, and the review is wedged for good.
      await exec('git', [...NO_SUBMODULES, '-C', worktree, 'checkout', '--force', '-B', branch, source]);
    } else {
      note(`creating worktree ${worktree}…`);
      mkdirSync(repo.worktreeRoot, { recursive: true });
      await exec('git', [...NO_SUBMODULES, '-C', repo.path, 'worktree', 'add', '-B', branch, worktree, source]);
    }
    await excludeScratch(worktree, spec.scratch);
    return localWorkspace(worktree);
  },
  async ensureTask(spec, note = () => {}) {
    const { path: repo, defaultBranch, worktreeRoot } = spec.repo;
    const remote = spec.repo.remote ?? 'origin';
    // the PR's branch lives on the push remote in a fork workflow
    const prRemote = spec.repo.pushRemote ?? remote;
    const branch = spec.branch;
    const ready = async (worktree: string) => {
      await excludeScratch(worktree, spec.scratch);
      return { workspace: localWorkspace(worktree), branch };
    };
    // git allows one checkout per branch: if some worktree (old path scheme,
    // manual checkout, attach shell) already has it, reuse that worktree.
    // A checkout that has been deleted out from under us is *still listed* —
    // and was still returned here, which is how a resume ended up starting an
    // agent in a directory that no longer existed. The lookup clears those.
    const found = await worktreeForBranch(repo, branch);
    for (const gone of found.cleared) {
      if (gone !== found.lost?.path) note(`cleared a stale worktree registration for ${gone}`);
    }
    if (found.lost) note(recoveryNote(branch, found.lost.head));
    if (found.path && found.path !== repo) return ready(found.path);

    const worktree = join(worktreeRoot, spec.name);
    if (existsSync(worktree)) {
      if (spec.adopt) {
        // adopting a PR into a pre-existing worktree: make sure it's on the PR's branch
        const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ({ stdout: '' }));
        if (stdout.trim() !== branch) {
          await exec('git', ['-C', repo, 'fetch', prRemote, branch]).catch(() => {});
          await exec('git', ['-C', worktree, 'checkout', branch]).catch(async () => {
            await exec('git', ['-C', worktree, 'checkout', '-b', branch, `${prRemote}/${branch}`]).catch(() => {});
          });
        }
      }
      return { workspace: localWorkspace(worktree), branch };
    }

    mkdirSync(worktreeRoot, { recursive: true });
    if (spec.adopt) {
      await exec('git', ['-C', repo, 'fetch', prRemote, branch]).catch(() => {});
      try {
        await exec('git', ['-C', repo, 'worktree', 'add', worktree, branch]);
      } catch {
        await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch, `${prRemote}/${branch}`]);
      }
      return ready(worktree);
    }
    await exec('git', ['-C', repo, 'fetch', remote, defaultBranch]);
    try {
      await exec('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch, `${remote}/${defaultBranch}`]);
    } catch {
      // branch already exists — attach the worktree to it instead
      await exec('git', ['-C', repo, 'worktree', 'add', worktree, branch]);
    }
    return ready(worktree);
  },
};

/**
 * Keep colinear's own scratch files out of git, per worktree: the subtask
 * checklist the agent writes, and the review document the operator's read of
 * the branch lands in — a review accidentally committed to a PR is worse than
 * no review at all.
 */
async function excludeScratch(worktree: string, files: string[]) {
  try {
    // the COMMON git dir, not this worktree's. `info/exclude` is only ever
    // read from the shared one — writing it under
    // `.git/worktrees/<name>/info/` looks right, is what
    // `--absolute-git-dir` hands you in a linked worktree, and is silently
    // ignored, which left both scratch files showing up in every agent's
    // `git status` (and one `git add -A` away from being committed).
    const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    const excludePath = join(stdout.trim(), 'info', 'exclude');
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    for (const file of files) {
      if (!existing.includes(file)) appendFileSync(excludePath, `${file}\n`);
    }
  } catch {
    // non-fatal; the prompt also tells the agent not to commit it
  }
}

/** The remote whose URL names this repository: forks push elsewhere, so `origin` is only a guess. */
export async function remoteFor(repoPath: string, repository: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', repoPath, 'remote', '-v']).catch(() => ({ stdout: '' }));
  for (const line of stdout.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (name && url?.toLowerCase().includes(repository.toLowerCase())) return name;
  }
  return 'origin';
}

/**
 * Never let git recurse into submodules on colinear's behalf.
 *
 * `submodule.recurse = true` is a perfectly reasonable thing to have in your
 * own git config, and it is not ours to change — but it turns every checkout
 * colinear runs into one that also tries to set up submodules, and git's
 * support for that inside a *linked worktree* is incomplete. What it leaves
 * behind is described on clearBrokenSubmodules below.
 *
 * Passed as `-c` rather than written into the repo's config: this is about
 * what colinear's own commands do, not about the operator's repository.
 */
export const NO_SUBMODULES = ['-c', 'submodule.recurse=false'];

/**
 * Put half-initialised submodules in a review checkout back to uninitialised.
 *
 * With submodule recursion on, a checkout in a linked worktree writes a `.git`
 * pointer into the submodule directory and a stub gitdir holding nothing but a
 * `config`, then gives up. Every later git command in that worktree — not just
 * checkout, but `status` and `diff` too — then dies with `not a git
 * repository`, and the review can never be refreshed again.
 *
 * Uninitialised is what a fresh worktree has anyway: colinear reads the pull
 * request's own diff and never wants submodule contents. So a pointer whose
 * gitdir is not a repository is removed rather than repaired.
 */
export function clearBrokenSubmodules(worktree: string): string[] {
  const modules = join(worktree, '.gitmodules');
  if (!existsSync(modules)) return [];
  const cleared: string[] = [];
  const text = readFileSync(modules, 'utf8');
  for (const m of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const path = m[1];
    const pointer = join(worktree, path, '.git');
    if (!existsSync(pointer) || statSync(pointer).isDirectory()) continue;
    const target = readFileSync(pointer, 'utf8').replace(/^gitdir:\s*/, '').trim();
    if (!target) continue;
    const gitdir = target.startsWith('/') ? target : join(worktree, path, target);
    // a real submodule checkout has a HEAD; the stub has only a config
    if (existsSync(join(gitdir, 'HEAD'))) continue;
    rmSync(pointer, { force: true });
    rmSync(gitdir, { recursive: true, force: true });
    cleared.push(path);
  }
  return cleared;
}
