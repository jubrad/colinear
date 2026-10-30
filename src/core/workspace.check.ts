import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChecks } from './checks.js';
import { localWorkspace, localWorkspaces, type Workspace } from './workspace.js';

/**
 * The daemon's way into a worktree: commands, files, and making one.
 *
 * Everything the daemon does in a worktree goes through `Workspace`, so this
 * is the contract a runner in another process — or another machine — has to
 * meet too. It runs against temporary repositories only.
 *
 * Run with `npx tsx src/core/workspace.check.ts`. `bin/check` runs it.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (cwd: string, ...args: string[]) => run('git', ['-C', cwd, ...args]);

// realpath: git reports resolved paths, and macOS makes /var a symlink
const root = realpathSync(mkdtempSync(join(tmpdir(), 'coli-workspace-check-')));

/** The behaviour every Workspace must have, whatever is behind it. */
async function contract(label: string, ws: Workspace) {
  const ok = await ws.exec(['sh', '-c', 'echo out; echo err >&2']);
  check(`${label}: a command that works says 0`, ok.code === 0, JSON.stringify(ok));
  check(`${label}: and keeps each stream`, ok.stdout === 'out\n' && ok.stderr === 'err\n');
  check(`${label}: and both, interleaved`, ok.output.includes('out') && ok.output.includes('err'));
  const bad = await ws.exec(['sh', '-c', 'exit 3']);
  check(`${label}: a command that fails says its code, without throwing`, bad.code === 3);
  const missing = await ws.exec(['no-such-command-coli']);
  check(`${label}: a command that cannot start says -1`, missing.code === -1 && missing.output.length > 0, JSON.stringify(missing));
  const input = await ws.exec(['cat'], { input: 'piped in' });
  check(`${label}: input reaches the command`, input.stdout === 'piped in');
  const env = await ws.exec(['sh', '-c', 'echo $COLI_CHECK'], { env: { COLI_CHECK: 'set' } });
  check(`${label}: env reaches the command`, env.stdout.trim() === 'set');
  const big = await ws.exec(['sh', '-c', 'yes x | head -c 5000'], { maxOutput: 1000 });
  check(`${label}: output is capped to its tail, and says so`, big.stdout.length === 1000 && big.truncated);
  const slow = await ws.exec(['sleep', '5'], { timeoutMs: 200 });
  check(`${label}: a timeout stops the command`, slow.code !== 0);
  const abort = new AbortController();
  const stopping = ws.exec(['sleep', '5'], { signal: abort.signal });
  abort.abort();
  check(`${label}: an abort stops the command`, (await stopping).code !== 0);

  await ws.writeFile('notes/a.md', 'first');
  check(`${label}: a written file reads back`, (await ws.readFile('notes/a.md')) === 'first');
  await ws.writeFile('notes/a.md', 'second');
  check(`${label}: and is replaced whole`, (await ws.readFile('notes/a.md')) === 'second');
  check(`${label}: exists says so`, (await ws.exists('notes/a.md')) && !(await ws.exists('notes/b.md')));
  check(`${label}: a missing file reads as undefined`, (await ws.readFile('notes/b.md')) === undefined);
  const sub = await ws.exec(['pwd'], { cwd: 'notes' });
  check(`${label}: cwd is relative to the worktree`, sub.stdout.trim() === join(ws.path, 'notes'), sub.stdout);

  // nothing outside the worktree, by any route
  const escapes: Array<[string, () => Promise<unknown>]> = [
    ['read ../', () => ws.readFile('../outside.txt')],
    ['read an absolute path', () => ws.readFile('/etc/hosts')],
    ['write ../', () => ws.writeFile('../outside.txt', 'x')],
    ['exists ../', () => ws.exists('../outside.txt')],
  ];
  for (const [what, attempt] of escapes) {
    const refused = await attempt().then(
      () => false,
      (e: unknown) => String(e).includes('outside the worktree'),
    );
    check(`${label}: refuses to ${what}`, refused);
  }
  const climbing = await ws.exec(['pwd'], { cwd: '..' });
  check(`${label}: refuses a cwd outside it`, climbing.code === -1 && climbing.output.includes('outside the worktree'), JSON.stringify(climbing));
}

try {
  // a remote to fetch from, and the main checkout colinear cuts worktrees from
  const origin = join(root, 'origin.git');
  run('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = join(root, 'seed');
  run('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'check@example.invalid');
  git(seed, 'config', 'user.name', 'check');
  writeFileSync(join(seed, 'README.md'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'first');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'pr-branch');
  writeFileSync(join(seed, 'pr.txt'), 'from the PR\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'the PR');
  git(seed, 'push', '-q', 'origin', 'pr-branch');
  const repo = join(root, 'repo');
  run('git', ['clone', '-q', origin, repo]);

  const repoCfg = { path: repo, defaultBranch: 'main', worktreeRoot: join(root, 'trees') };
  const scratch = ['.colinear-subtasks.md', '.colinear-review.md'];
  const notes: string[] = [];
  const made = await localWorkspaces.ensureTask({ name: 'ENG-1', branch: 'coli/eng-1', repo: repoCfg, scratch }, (l) => notes.push(l));
  check('a task worktree is cut where its name says', made.workspace.path === join(root, 'trees', 'ENG-1'), made.workspace.path);
  check('on its own branch', git(made.workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'coli/eng-1');
  check('from the remote default branch', git(made.workspace.path, 'log', '-1', '--format=%s') === 'first');
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  check('with the scratch files kept out of git', scratch.every((f) => exclude.includes(f)), exclude);
  await made.workspace.writeFile('.colinear-subtasks.md', '- [ ] one\n');
  check('so a scratch file never shows as a change', (await made.workspace.exec(['git', 'status', '--porcelain'])).stdout === '');

  const again = await localWorkspaces.ensureTask({ name: 'ENG-1', branch: 'coli/eng-1', repo: repoCfg, scratch });
  check('asking again finds the same worktree', again.workspace.path === made.workspace.path && notes.length === 0);

  const adopted = await localWorkspaces.ensureTask({ name: 'ENG-2', branch: 'pr-branch', adopt: true, repo: repoCfg, scratch });
  check('adopting a PR checks out its branch', git(adopted.workspace.path, 'rev-parse', '--abbrev-ref', 'HEAD') === 'pr-branch');
  check("with the PR's commits", (await adopted.workspace.readFile('pr.txt')) === 'from the PR\n');

  check('open names an existing one by path', localWorkspaces.open(made.workspace.path).path === made.workspace.path);

  await contract('local', made.workspace);

  // checks run through the workspace, in it
  writeFileSync(join(made.workspace.path, 'fail.sh'), 'echo failing on purpose; exit 1\n');
  const results = await runChecks(
    [
      { name: 'passes', cmd: 'test -f README.md && echo fine' },
      { name: 'fails', cmd: 'sh fail.sh' },
    ],
    made.workspace,
  );
  check('a passing check passes, in the worktree', results[0].ok && results[0].output.includes('fine'), JSON.stringify(results[0]));
  check('a failing check fails, with its output', !results[1].ok && results[1].output.includes('failing on purpose'), JSON.stringify(results[1]));
  const cancelled = new AbortController();
  cancelled.abort();
  const none = await runChecks([{ name: 'never', cmd: 'echo ran' }], made.workspace, cancelled.signal);
  check('a cancelled task runs no checks', !none[0].ok && none[0].output === 'cancelled');

  mkdirSync(join(root, 'empty'));
  await contract('a bare directory', localWorkspace(join(root, 'empty')));
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`workspace: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — commands, files and new worktrees go through Workspace, and nothing reaches\n     outside the worktree');
