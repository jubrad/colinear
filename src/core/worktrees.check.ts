import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryNote, registrations, worktreeForBranch } from './worktrees.js';

/**
 * Clobber a worktree and prove colinear can get it back.
 *
 * The failure this guards against is silent and specific: a checkout removed
 * by anything except `git worktree remove` stays *registered*, so a lookup
 * keyed on the branch keeps answering with a path that is not there. The next
 * dispatch then starts an agent in a directory that does not exist, and even a
 * deliberate re-add is refused. None of that is visible to a typechecker, and
 * none of it shows up until the day you actually need to resume something.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);

// realpath, because git reports resolved paths and macOS makes /var a symlink
// to /private/var — every comparison below is against what git says
const root = realpathSync(mkdtempSync(join(tmpdir(), 'coli-worktrees-check-')));

try {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'check@example.invalid');
  git(repo, 'config', 'user.name', 'check');
  writeFileSync(join(repo, 'README.md'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'first');

  const wt = join(root, 'trees', 'TASK-1');
  mkdirSync(join(root, 'trees'), { recursive: true });
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'coli/TASK-1');
  writeFileSync(join(wt, 'work.txt'), 'committed work\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'the work');
  const head = git(wt, 'rev-parse', 'HEAD');
  writeFileSync(join(wt, 'uncommitted.txt'), 'this one is not coming back\n');

  // a live checkout is found, and nothing is cleared
  const live = await worktreeForBranch(repo, 'coli/TASK-1');
  check('a live worktree is found', live.path === wt, live.path ?? 'nothing');
  check('and nothing is cleared for it', live.cleared.length === 0 && !live.lost);

  // ── clobber it, the way anything other than colinear would ─────────────
  rmSync(wt, { recursive: true, force: true });

  check(
    'git still lists the dead registration',
    (await registrations(repo)).some((r) => r.path === wt && r.prunable),
  );

  const after = await worktreeForBranch(repo, 'coli/TASK-1');
  check('the dead path is no longer offered as live', after.path === undefined, after.path ?? '');
  check('the registration was cleared', after.cleared.includes(wt), after.cleared.join(', ') || 'none');
  check('and it says which branch lost its checkout', after.lost?.path === wt);
  check('with the commit it was on', after.lost?.head === head, `${after.lost?.head} vs ${head}`);
  check(
    'gone from the registrations too',
    !(await registrations(repo)).some((r) => r.path === wt),
  );

  // ── which is what makes the re-add possible at all ─────────────────────
  // git refuses this outright while the stale registration stands, which is
  // the whole bug — caught here as a failure rather than a stack trace
  let readded = '';
  try {
    git(repo, 'worktree', 'add', '-q', wt, 'coli/TASK-1');
  } catch (err) {
    readded = String((err as { stderr?: string }).stderr ?? err).split('\n')[0];
  }
  check('the checkout can be re-added at the same path', readded === '', readded);
  check('the checkout is back', existsSync(wt));
  if (existsSync(wt)) {
    check('on the same branch', git(wt, 'rev-parse', '--abbrev-ref', 'HEAD') === 'coli/TASK-1');
    check('at the same commit', git(wt, 'rev-parse', 'HEAD') === head);
    check('with the committed work', existsSync(join(wt, 'work.txt')));
    check('and, honestly, without the uncommitted work', !existsSync(join(wt, 'uncommitted.txt')));
  }
  check(
    'the note says both halves of that',
    /Committed work is back/.test(recoveryNote('coli/TASK-1', head)) &&
      /uncommitted was not/.test(recoveryNote('coli/TASK-1', head)),
  );

  const healthy = await worktreeForBranch(repo, 'coli/TASK-1');
  check('and the lookup is quiet again', healthy.path === wt && healthy.cleared.length === 0);

  // ── a locked worktree survives prune, so it must not be reported cleared ─
  const locked = join(root, 'trees', 'TASK-2');
  git(repo, 'worktree', 'add', '-q', locked, '-b', 'coli/TASK-2');
  git(repo, 'worktree', 'lock', locked);
  rmSync(locked, { recursive: true, force: true });
  const lockedLookup = await worktreeForBranch(repo, 'coli/TASK-2');
  check('a locked-but-missing worktree is not offered', lockedLookup.path === undefined);
  check(
    'and is not claimed as cleared, because prune leaves it',
    !lockedLookup.cleared.includes(locked),
    lockedLookup.cleared.join(', ') || 'none',
  );

  // ── one worktree going does not disturb another ────────────────────────
  const other = join(root, 'trees', 'TASK-3');
  git(repo, 'worktree', 'add', '-q', other, '-b', 'coli/TASK-3');
  writeFileSync(join(other, 'keep.txt'), 'still here\n');
  const third = await worktreeForBranch(repo, 'coli/TASK-3');
  check('a healthy neighbour is untouched', third.path === other && existsSync(join(other, 'keep.txt')));
  check('and the README is intact', readFileSync(join(repo, 'README.md'), 'utf8') === 'one\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`worktree recovery: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log('ok — a clobbered worktree is noticed, cleared, and can be rebuilt from its branch');
