import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureChanges, sameChanges } from './changes.js';

/**
 * Live change counts, against a real repository: a base, a branch with a
 * commit, then work in flight on top — an edit not committed, a file never
 * added, and the review document, which is not the agent's work. What matters
 * is that uncommitted and untracked work counts (that is most of what an agent
 * has done mid-session) and that measuring never touches the index.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const dir = mkdtempSync(join(tmpdir(), 'colinear-changes-'));
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.email=check@example.com', '-c', 'user.name=check', ...args], { encoding: 'utf8' });

try {
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.ts'), 'one\ntwo\nthree\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  writeFileSync(join(dir, 'a.ts'), 'one\n2\nthree\nfour\n');
  git('commit', '-q', '-am', 'committed work');

  const committed = await measureChanges(dir, ['nope...HEAD', 'main...HEAD']);
  check('falls back to the range that resolves', Boolean(committed));
  check(
    'committed work counts',
    committed?.files === 1 && committed.added === 2 && committed.removed === 1 && committed.uncommitted === 0,
    JSON.stringify(committed),
  );

  writeFileSync(join(dir, 'a.ts'), 'one\n2\nthree\nfour\nfive\n');
  writeFileSync(join(dir, 'b.ts'), 'new\nfile\n');
  writeFileSync(join(dir, '.colinear-review.md'), 'the operator\'s notes\nnot work\n');
  const index = git('ls-files', '--stage');
  const live = await measureChanges(dir, ['main...HEAD']);
  check(
    'uncommitted and untracked work counts, the review document does not',
    live?.files === 2 && live.added === 5 && live.removed === 1 && live.uncommitted === 2,
    JSON.stringify(live),
  );
  check('measuring leaves the index alone', git('ls-files', '--stage') === index);
  check('a change is a change', !sameChanges(committed, live));
  check('the same counts are the same', sameChanges(live, await measureChanges(dir, ['main...HEAD'])));
  check('no range resolves: no answer rather than zero', (await measureChanges(dir, ['nope...HEAD'])) === undefined);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`changes: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a working task counts its committed, uncommitted and untracked work, leaves out the\n     review document, and never touches the index to do it');
