import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Back up one machine, restore onto another, and check the work survived.
 *
 * This is the one feature where "it typechecked" is worth nothing: the whole
 * point is that a laptop can be thrown away afterwards. So the check builds a
 * complete fake installation — a repository with an upstream, a worktree with
 * commits nobody has pushed, uncommitted edits, untracked files, a build
 * directory that must *not* travel, a review document that must, state, config
 * and transcripts — moves it to a second home directory with a different path,
 * and asserts on what came out.
 *
 * The second home is deliberately named differently. That is the case a
 * backup taken for a new computer actually hits, and it is the one that breaks
 * silently: a transcript is filed under its working directory encoded into a
 * directory name, so a home that moved leaves every conversation filed under a
 * path that no longer exists.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'index.tsx');
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/** The passphrase every backup in this check is made with, unless said otherwise. */
const PASS = 'correct horse battery staple';

function run(cmd: string, args: string[], opts: { cwd?: string; home?: string; pass?: string } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // captured rather than inherited: git narrates every clone, and a gate
    // that prints twenty lines of someone else's progress is a gate nobody
    // reads. A failure still carries its stderr on the thrown error.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.home
      ? {
          ...process.env,
          HOME: opts.home,
          COLINEAR_STATE_DIR: '',
          // the non-interactive path, which is what a scheduled backup uses
          COLINEAR_BACKUP_PASSPHRASE: opts.pass ?? PASS,
        }
      : process.env,
  });
}

function git(cwd: string, ...args: string[]): string {
  return run('git', ['-C', cwd, ...args]).trim();
}

const root = mkdtempSync(join(tmpdir(), 'coli-backup-check-'));
// two homes, two usernames, deliberately different lengths — the case a
// backup taken for a new computer actually hits
const oldHome = join(root, 'Users', 'ada');
const newHome = join(root, 'Users', 'grace-h');

try {
  // ── the machine being left behind ──────────────────────────────────────
  const upstream = join(root, 'upstream.git');
  mkdirSync(upstream, { recursive: true });
  run('git', ['init', '--bare', '-b', 'main', upstream]);

  const repo = join(oldHome, 'work', 'widget');
  mkdirSync(dirname(repo), { recursive: true });
  run('git', ['clone', upstream, repo]);
  git(repo, 'config', 'user.email', 'check@example.invalid');
  git(repo, 'config', 'user.name', 'check');
  writeFileSync(join(repo, 'README.md'), 'the widget\n');
  writeFileSync(join(repo, '.gitignore'), 'target/\n.venv/\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'first');
  git(repo, 'push', 'origin', 'main');

  // a worktree mid-task: one unpushed commit, one uncommitted edit, one
  // untracked file, a build directory, and colinear's own review document
  const worktreeRoot = join(oldHome, 'work', 'trees');
  const worktree = join(worktreeRoot, 'WID-1');
  mkdirSync(worktreeRoot, { recursive: true });
  git(repo, 'worktree', 'add', worktree, '-b', 'coli/WID-1');
  writeFileSync(join(worktree, 'feature.txt'), 'committed work\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-m', 'the unpushed commit');
  writeFileSync(join(worktree, 'README.md'), 'the widget\nedited but not committed\n');
  writeFileSync(join(worktree, 'notes.txt'), 'untracked but wanted\n');
  mkdirSync(join(worktree, 'target', 'debug'), { recursive: true });
  writeFileSync(join(worktree, 'target', 'debug', 'huge.bin'), 'x'.repeat(2 * 1024 * 1024));
  mkdirSync(join(worktree, '.venv'), { recursive: true });
  writeFileSync(join(worktree, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  // the review document is git-excluded so no agent commits it, which is
  // exactly why a naive "untracked files" sweep would drop it
  const excludeFile = join(repo, '.git', 'info', 'exclude');
  mkdirSync(dirname(excludeFile), { recursive: true });
  writeFileSync(excludeFile, '.colinear-review.md\n');
  writeFileSync(join(worktree, '.colinear-review.md'), '# review\n\n```findings\n[]\n```\n');

  // config, state and a conversation
  const configDir = join(oldHome, '.config', 'colinear');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify(
      {
        provider: 'sqlite',
        repo: 'acme/widget',
        repos: [
          {
            name: 'acme/widget',
            path: repo,
            defaultBranch: 'main',
            remote: 'origin',
            worktreeRoot,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const stateDir = join(oldHome, '.local', 'state', 'colinear');
  mkdirSync(join(stateDir, 'plans'), { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    `${JSON.stringify({ version: 3, tasks: [{ issue: { id: 'i1', identifier: 'WID-1' }, worktree }], reviews: [], plans: [] })}\n`,
  );
  writeFileSync(join(stateDir, 'colinear.log'), 'x'.repeat(4 * 1024 * 1024));
  writeFileSync(join(stateDir, 'coli.pid'), '99999\n');
  const chatDir = join(oldHome, '.claude', 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(chatDir, { recursive: true });
  // a transcript the way Claude Code writes one: every record names the
  // directory it happened in, and the tool calls name absolute files
  writeFileSync(
    join(chatDir, 'sess-1.jsonl'),
    [
      JSON.stringify({ type: 'user', cwd: worktree, sessionId: 'sess-1', text: 'have a look at the README' }),
      JSON.stringify({
        type: 'assistant',
        cwd: worktree,
        toolUse: { name: 'Read', input: { file_path: join(worktree, 'README.md') } },
      }),
      JSON.stringify({ type: 'assistant', cwd: worktree, toolUse: { name: 'Bash', input: { command: `ls ${worktree}` } } }),
    ].join('\n') + '\n',
  );
  // a plan can name a checkout in prose, and a channel can quote one
  writeFileSync(join(stateDir, 'plans', 'p1.md'), `# a plan\n\nthe work is in ${worktree}\n`);

  // ── back it up ─────────────────────────────────────────────────────────
  const archive = join(root, 'backup.tar.gz.enc');
  const out = run('npx', ['tsx', CLI, 'backup', '--out', archive], { home: oldHome });
  check('the backup ran', existsSync(archive), out.slice(-400));

  // ── it is encrypted, because nobody asked for it not to be ─────────────
  const head = existsSync(archive) ? readFileSync(archive).subarray(0, 9).toString('utf8') : '';
  check('the default archive is encrypted', head === 'COLIBAK1\n', JSON.stringify(head));
  check('and is not a tarball any more', fails(() => run('tar', ['-tzf', archive])));
  check('the operator is told the passphrase is not recoverable', /password manager/.test(out), out.slice(-300));
  check(
    'no plaintext archive is left behind',
    !readdirSync(root).some((f) => f.endsWith('.tar.gz') && f !== 'backup-plain.tar.gz'),
    readdirSync(root).join(', '),
  );

  const size = existsSync(archive) ? readFileSync(archive).length : 0;
  // the build directory alone is 2M before compression; anything near that
  // means the exclusion did not happen
  check('the build directory did not travel', size < 512 * 1024, `${size} bytes`);
  check('it says what it took', /1 worktrees/.test(out) && /1 conversations/.test(out), out.slice(-300));

  // ── restore onto a machine whose home is somewhere else ────────────────
  const newRepo = join(newHome, 'work', 'widget');
  mkdirSync(dirname(newRepo), { recursive: true });
  run('git', ['clone', upstream, newRepo]);
  git(newRepo, 'config', 'user.email', 'check@example.invalid');
  git(newRepo, 'config', 'user.name', 'check');

  const dry = run('npx', ['tsx', CLI, 'restore', archive, '--dry-run'], { home: newHome });
  check('a dry run writes nothing', !existsSync(join(newHome, '.config', 'colinear', 'config.json')), dry.slice(-300));
  check('and still says what it would do', /worktree/.test(dry) && /conversations/.test(dry), dry.slice(-300));

  const done = run('npx', ['tsx', CLI, 'restore', archive], { home: newHome });

  // config, with every path pointing at this machine
  const restoredConfig = join(newHome, '.config', 'colinear', 'config.json');
  check('the config came back', existsSync(restoredConfig), done.slice(-400));
  if (existsSync(restoredConfig)) {
    const body = readFileSync(restoredConfig, 'utf8');
    check('its paths were rewritten', body.includes(newHome) && !body.includes(oldHome));
  }

  // state, minus the things that should not have been carried
  const newState = join(newHome, '.local', 'state', 'colinear');
  check('state came back', existsSync(join(newState, 'state.json')));
  check('so did the plans', existsSync(join(newState, 'plans', 'p1.md')));
  check('the log did not', !existsSync(join(newState, 'colinear.log')));
  check('nor the pidfile', !existsSync(join(newState, 'coli.pid')));
  if (existsSync(join(newState, 'state.json'))) {
    const body = readFileSync(join(newState, 'state.json'), 'utf8');
    check("the board's worktree paths were rewritten", body.includes(newHome) && !body.includes(oldHome));
  }

  // the conversation, re-filed under the directory it will actually resume in
  // — name *and* contents
  const newWorktree = join(newHome, 'work', 'trees', 'WID-1');
  const newChatDir = join(newHome, '.claude', 'projects', newWorktree.replace(/[^a-zA-Z0-9]/g, '-'));
  const restoredChat = join(newChatDir, 'sess-1.jsonl');
  check('the conversation is filed where a resume will look for it', existsSync(restoredChat));
  if (existsSync(restoredChat)) {
    const body = readFileSync(restoredChat, 'utf8');
    const records = body.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    check(
      'every record now says it happened in the new home',
      records.every((r) => r.cwd === newWorktree),
      JSON.stringify(records[0]?.cwd),
    );
    check('the file a tool read was repointed too', body.includes(join(newWorktree, 'README.md')));
    check('and a command that named the directory', body.includes(`ls ${newWorktree}`));
    check('nothing still points at the old home', !body.includes(oldHome), body.slice(0, 200));
  }
  const restoredPlan = join(newState, 'plans', 'p1.md');
  check(
    'a plan that named a checkout was rewritten',
    existsSync(restoredPlan) && readFileSync(restoredPlan, 'utf8').includes(newWorktree),
  );

  // the worktree itself
  check('the worktree was rebuilt', existsSync(newWorktree), done.slice(-500));
  if (existsSync(newWorktree)) {
    check('git knows about it', git(newRepo, 'worktree', 'list').includes(newWorktree));
    check('on its own branch', git(newWorktree, 'rev-parse', '--abbrev-ref', 'HEAD') === 'coli/WID-1');
    check('the unpushed commit is there', git(newWorktree, 'log', '-1', '--pretty=%s') === 'the unpushed commit');
    check('and its file', existsSync(join(newWorktree, 'feature.txt')));
    check(
      'the uncommitted edit survived',
      readFileSync(join(newWorktree, 'README.md'), 'utf8').includes('edited but not committed'),
    );
    check('so did the untracked file', existsSync(join(newWorktree, 'notes.txt')));
    check('and the review document', existsSync(join(newWorktree, '.colinear-review.md')));
    check('the build directory did not come with it', !existsSync(join(newWorktree, 'target')));
    check('nor the virtualenv', !existsSync(join(newWorktree, '.venv')));
    check(
      'and git still sees the edit as uncommitted',
      git(newWorktree, 'status', '--porcelain').includes('README.md'),
    );
  }

  // --list reads the manifest without unpacking anything
  const listed = run('npx', ['tsx', CLI, 'restore', archive, '--list'], { home: newHome });
  check('--list names the branch', listed.includes('coli/WID-1'), listed.slice(-200));
  check('--list counts the conversations', /chats\s+1 in 1 directories/.test(listed), listed.slice(-200));

  // the version guard is the whole basis of "restore from the same version",
  // so it gets checked rather than assumed
  // ── the ways it must refuse ────────────────────────────────────────────
  check(
    'a wrong passphrase is refused as such',
    refused(archive, newHome, /wrong passphrase/, 'not the passphrase'),
  );
  check(
    'and with no passphrase at all it says what is needed',
    refused(archive, newHome, /encrypted/, ''),
  );

  // one byte, in the body rather than the header: the tag has to catch it
  const tampered = join(root, 'tampered.tar.gz.enc');
  const bytes = readFileSync(archive);
  bytes[bytes.length - 200] ^= 0xff;
  writeFileSync(tampered, bytes);
  check(
    'a modified archive fails its integrity check',
    refused(tampered, newHome, /integrity check/),
    'GCM should not let an edited body through',
  );

  // ── --no-encrypt, for the operator who asks for it outright ────────────
  const plainArchive = join(root, 'backup-plain.tar.gz');
  const plainOut = run('npx', ['tsx', CLI, 'backup', '--out', plainArchive, '--no-encrypt'], { home: oldHome });
  check('--no-encrypt warns before it does it', /WARNING/.test(plainOut), plainOut.slice(0, 300));
  check('and writes a real tarball', !fails(() => run('tar', ['-tzf', plainArchive])));

  const doctored = join(root, 'from-the-future.tar.gz');
  retagArchive(plainArchive, doctored, (m) => ({ ...m, colinear: '99.0.0' }));
  check('a different colinear version is refused', refused(doctored, newHome, /same version/));
  const alien = join(root, 'from-another-os.tar.gz');
  retagArchive(plainArchive, alien, (m) => ({ ...m, platform: 'sunos' }));
  check('a different OS is refused', refused(alien, newHome, /same OS/));

  // restoring twice must not destroy what is already there
  const again = run('npx', ['tsx', CLI, 'restore', archive], { home: newHome });
  check('a second restore leaves the worktree alone', /already exists/.test(again), again.slice(-300));
  check(
    'and keeps the previous config beside the new one',
    existsSync(`${restoredConfig}.before-restore`),
    readdirSync(join(newHome, '.config', 'colinear')).join(', '),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** Rewrite an archive's manifest, to stand in for one written elsewhere. */
function retagArchive(from: string, to: string, edit: (m: Record<string, unknown>) => Record<string, unknown>): void {
  const dir = mkdtempSync(join(tmpdir(), 'coli-retag-'));
  try {
    run('tar', ['-xzf', from, '-C', dir]);
    const path = join(dir, 'manifest.json');
    writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, 'utf8'))), null, 2));
    run('tar', ['-czf', to, '-C', dir, '.']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Did restore refuse this archive, for the reason it should have? */
function refused(archive: string, home: string, why: RegExp, pass?: string): boolean {
  try {
    run('npx', ['tsx', CLI, 'restore', archive], { home, pass });
    return false; // it went ahead, which is the bug
  } catch (err) {
    return why.test(String((err as { stderr?: string }).stderr ?? err));
  }
}

/** Did this command exit non-zero? */
function fails(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

if (failures.length) {
  console.error(`backup round trip: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — backed up one machine, encrypted, and restored it onto another with a different home',
);
