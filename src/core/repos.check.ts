/**
 * Naming a repo by owner/name rather than by a checkout to run gh in.
 *
 * Run with `npx tsx src/core/repos.check.ts`. `bin/check` runs it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoSlug, slugFromUrl } from './repos.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const shapes: Array<[string, string | undefined]> = [
  ['git@github.com:example/api.git', 'example/api'],
  ['git@github.com:example/api', 'example/api'],
  ['https://github.com/example/api.git', 'example/api'],
  ['https://github.com/example/api', 'example/api'],
  ['https://github.com/example/api/', 'example/api'],
  ['ssh://git@github.com/example/api.git', 'example/api'],
  ['https://user:token@github.com/example/api.git', 'example/api'],
  ['https://ghe.example.com/team/svc.git', 'team/svc'],
  ['example/api', undefined],
  ['', undefined],
  ['/srv/git/api.git', undefined],
];
for (const [url, want] of shapes) check(`slug of ${url || '(empty)'}`, slugFromUrl(url) === want, String(slugFromUrl(url)));

const run = async (): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coli-repos-check-')));
  try {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'remote', 'add', 'upstream', 'git@github.com:example/api.git']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:someone/api.git']);
    check('the slug comes from the upstream remote named in the config', (await repoSlug({ path: root, remote: 'upstream' })) === 'example/api');
    check('origin when none is named', (await repoSlug({ path: root })) === 'someone/api');
    check('the config wins when it says', (await repoSlug({ path: root, remote: 'upstream', github: 'example/other' })) === 'example/other');
    check('a remote that is not there gives nothing, not a guess', (await repoSlug({ path: root, remote: 'nope' })) === undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

await run();
if (failures.length) {
  console.error(`repos: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a repo is named owner/name from its config or its upstream remote, never guessed');
