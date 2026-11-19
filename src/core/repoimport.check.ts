import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRepoToConfig, cloneRootFor, parseSlug } from './repoimport.js';
import type { Config } from './types.js';

/**
 * Importing a repo writes to the operator's config file, so what is pinned
 * here is that the write adds one repo and touches nothing else in the file,
 * that a second import of the same clone adds nothing, that a clone lands
 * next to the repos already there, and that a repo is recognised however it
 * was pasted.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

check('a slug is a slug', parseSlug('jubrad/colinear') === 'jubrad/colinear');
check('a PR URL names its repo', parseSlug('https://github.com/jubrad/colinear/pull/183') === 'jubrad/colinear');
check('an ssh remote names its repo', parseSlug('git@github.com:jubrad/colinear.git') === 'jubrad/colinear');
check('anything else is refused', parseSlug('colinear') === undefined && parseSlug('https://gitlab.com/a/b') === undefined);

check('cloneRoot wins', cloneRootFor({ cloneRoot: '/x', repos: [{ path: '/a/b' }] } as Config) === '/x');
check('otherwise where most repos already are', cloneRootFor({ repos: [{ path: '/a/x' }, { path: '/b/y' }, { path: '/b/z' }] } as Config) === '/b');

const file = join(mkdtempSync(join(tmpdir(), 'colinear-import-')), 'config.json');
writeFileSync(file, JSON.stringify({ linearApiKey: 'k', concurrency: 2, repos: [{ name: 'a', path: '/a' }] }));
addRepoToConfig(file, { name: 'b', path: '/b', defaultBranch: 'trunk', description: 'the b repo' });
const after = JSON.parse(readFileSync(file, 'utf8'));
check('the repo is appended', after.repos.length === 2 && after.repos[1].name === 'b' && after.repos[1].defaultBranch === 'trunk');
check('its description comes with it, for triage', after.repos[1].description === 'the b repo');
check('nothing else in the file moves', after.linearApiKey === 'k' && after.concurrency === 2 && after.repos[0].path === '/a');
addRepoToConfig(file, { name: 'b2', path: '/b', defaultBranch: 'main' });
check('the same clone twice is added once', JSON.parse(readFileSync(file, 'utf8')).repos.length === 2);

if (failures.length) {
  console.error(`repo import: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — an import appends one repo to the config and touches nothing else, once per clone,\n     next to the repos already there, from a slug, a URL or a remote');
