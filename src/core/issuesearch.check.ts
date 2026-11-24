import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqliteProvider } from './providers/sqlite.js';
import type { Config } from './types.js';

/**
 * :issues narrows by scope — no project issues unless `p`, your own unless
 * a team is picked — and a search is how you reach past that. What is pinned,
 * against a throwaway local tracker: an issue in a project, assigned to
 * nobody, is invisible to the default list and found by its identifier in
 * any case, and by its title.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const cfg = { provider: 'sqlite', sqlitePath: join(mkdtempSync(join(tmpdir(), 'colinear-search-')), 'local.db') } as unknown as Config;
const provider = sqliteProvider(cfg);
const scopes = await provider.scopes();
const scope = scopes[0];
if (!scope) {
  failures.push('the local tracker has no scope to file into');
} else {
  const project = await provider.createProject({ scopeId: scope.id, name: 'Hardening', description: 'grouping' } as never);
  const inProject = await provider.create({ scopeId: scope.id, title: 'Set readOnlyRootFilesystem on workloads', projectId: project.id } as never);
  await provider.create({ scopeId: scope.id, title: 'Something unrelated' } as never);

  const listed = await provider.issues(undefined, { includeProjects: false });
  check('the default list leaves the project issue out', !listed.some((i) => i.id === inProject.id));
  const byId = await provider.search(inProject.identifier);
  check('its identifier finds it anyway', byId.length === 1 && byId[0].id === inProject.id, byId.map((i) => i.identifier).join());
  check('in any case', (await provider.search(inProject.identifier.toLowerCase())).some((i) => i.id === inProject.id));
  const byTitle = await provider.search('readonlyroot');
  check('and so does part of its title', byTitle.some((i) => i.id === inProject.id) && !byTitle.some((i) => i.title === 'Something unrelated'));
  check('two letters search nothing', (await provider.search('re')).length === 0);
}

if (failures.length) {
  console.error(`issue search: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — an issue the list narrows away (in a project, unassigned) is found by its identifier\n     in any case and by its title');
