import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubName, mergeLayers, type OrgSpec } from './orglayer.js';

/**
 * The org layer under a user's config: one check per row of the table in
 * design/multi-user/config.md, "What belongs where".
 *
 * The rules that matter most are the ones that only ever narrow. A lock the
 * merge forgets, a permission mode it lets a user loosen, or a deny rule a
 * user can delete would each widen what agents may do in every user's
 * namespace, and nothing else would notice.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const merge = (org: OrgSpec | undefined, user: Record<string, unknown>) => mergeLayers(org, user, '/state');
const ignoredKeys = (r: ReturnType<typeof merge>, from: 'org' | 'you' = 'you') =>
  r.layers.ignored.filter((i) => i.from === from).map((i) => i.key);

// ---- no org: single-user mode is untouched
{
  const user = { concurrency: 5, repos: [{ path: '/x' }], runner: 'process', linearApiKey: 'k' };
  const r = merge(undefined, user);
  eq('without an org the user file passes through', r.raw, user);
  eq('and every key is yours', r.layers.sources, { concurrency: 'you', repos: 'you', runner: 'you', linearApiKey: 'you' });
  eq('and nothing is ignored', r.layers.ignored, []);
}

// ---- repos: org only
{
  const org: OrgSpec = {
    repos: [
      { name: 'api', url: 'https://github.com/example/api.git', checks: [{ name: 'lint', cmd: 'bin/lint' }] },
      { name: 'web', url: 'https://git.example.com/web', defaultBranch: 'trunk' },
    ],
  };
  const r = merge(org, { repos: [{ name: 'mine', path: '/home/me/mine' }] });
  const repos = r.raw.repos as Array<Record<string, unknown>>;
  eq('the org lists the repos', repos.map((x) => x.name), ['api', 'web']);
  eq('a user repo is ignored, with the reason', ignoredKeys(r), ['repos']);
  eq('owner/name from a GitHub URL', repos[0].github, 'example/api');
  check('no owner/name guessed for another host', !('github' in repos[1]));
  eq('a repo keeps its branch and checks', [repos[1].defaultBranch, repos[0].checks], ['trunk', [{ name: 'lint', cmd: 'bin/lint' }]]);
  eq('and its clone URL', repos[0].url, 'https://github.com/example/api.git');
  eq('its source is the org', r.layers.sources.repos, 'org');
}
eq('github: ssh form', githubName('git@github.com:example/api.git'), 'example/api');
eq('github: no .git', githubName('https://github.com/example/api'), 'example/api');
eq('github: not a repo URL', githubName('https://github.com/example'), undefined);

// ---- tracker: org only
{
  const r = merge({ tracker: { provider: 'linear' } }, { provider: 'sqlite' });
  eq("the org's tracker wins", r.raw.provider, 'linear');
  eq("the user's is ignored", ignoredKeys(r), ['provider']);
}

// ---- model, fallbackModel: the user's choice, within the allow list
{
  const allow = { models: { allow: ['sonnet', 'opus'] }, config: { model: { general: 'sonnet', review: 'opus' } } };
  const mine = merge(allow, { model: 'opus' });
  eq('an allowed model of yours wins', mine.raw.model, { general: 'opus', review: 'opus' });
  eq('merged scope by scope, so both layers count', mine.layers.sources.model, 'both');

  const scoped = merge(allow, { model: { review: 'sonnet' } });
  eq("naming one scope keeps the org's others", scoped.raw.model, { general: 'sonnet', review: 'sonnet' });

  const banned = merge(allow, { model: 'fable' });
  eq("a model outside the list falls back to the org's", banned.raw.model, { general: 'sonnet', review: 'opus' });
  eq('and says why', banned.layers.ignored[0]?.reason, '"fable" isn\'t allowed: the org allows sonnet, opus');

  const partly = merge(allow, { model: { general: 'opus', triage: 'haiku' } });
  eq('only the disallowed scope is dropped', partly.raw.model, { general: 'opus', review: 'opus' });
  eq('and named', ignoredKeys(partly), ['model.triage']);

  const aliases = merge(allow, { fallbackModel: 'default', model: { triage: '' } });
  eq('"default" and off are always allowed', [aliases.raw.fallbackModel, ignoredKeys(aliases)], ['default', []]);

  const open = merge({ config: { model: 'sonnet' } }, { model: 'fable' });
  eq('no allow list, no limit', open.raw.model, { general: 'fable' });
}

// ---- agentPermissionMode: lockable; unlocked, only stricter
{
  const org = { config: { agentPermissionMode: 'acceptEdits' } };
  eq('stricter is fine', merge(org, { agentPermissionMode: 'plan' }).raw.agentPermissionMode, 'plan');
  eq('the same is fine', merge(org, { agentPermissionMode: 'acceptEdits' }).raw.agentPermissionMode, 'acceptEdits');
  const looser = merge(org, { agentPermissionMode: 'bypassPermissions' });
  eq('looser keeps the org mode', looser.raw.agentPermissionMode, 'acceptEdits');
  eq('looser is ignored, with the reason', ignoredKeys(looser), ['agentPermissionMode']);
  eq('auto is looser than acceptEdits', merge(org, { agentPermissionMode: 'auto' }).raw.agentPermissionMode, 'acceptEdits');
  const locked = merge({ ...org, locked: ['agentPermissionMode'] }, { agentPermissionMode: 'plan' });
  eq('locked, even stricter is refused', [locked.raw.agentPermissionMode, ignoredKeys(locked)], ['acceptEdits', ['agentPermissionMode']]);
  eq('with no org mode, yours stands', merge({}, { agentPermissionMode: 'bypassPermissions' }).raw.agentPermissionMode, 'bypassPermissions');
}

// ---- denyTools: union
{
  const org = { config: { denyTools: ['Bash(git push --force:*)'] } };
  const r = merge(org, { denyTools: ['Bash(rm:*)'] });
  eq('a user adds rules', r.raw.denyTools, ['Bash(git push --force:*)', 'Bash(rm:*)']);
  eq('from both layers', r.layers.sources.denyTools, 'both');
  eq("and an empty list can't remove the org's", merge(org, { denyTools: [] }).raw.denyTools, ['Bash(git push --force:*)']);
  eq('no duplicates', merge(org, { denyTools: ['Bash(git push --force:*)'] }).raw.denyTools, ['Bash(git push --force:*)']);
}

// ---- guidance: concatenated, org first, per scope
{
  const r = merge(
    { config: { guidance: { general: 'Org rules.', review: ['Be', 'kind.'] } } },
    { guidance: 'My rules.' },
  );
  eq('org first, scope by scope, whatever shape either was written in', r.raw.guidance, {
    general: 'Org rules.\n\nMy rules.',
    review: 'Be\nkind.',
  });
}

// ---- concurrency: capped
{
  const org = { limits: { concurrency: 4 } };
  const over = merge(org, { concurrency: 10 });
  eq('capped', over.raw.concurrency, 4);
  eq('and said', over.layers.ignored[0]?.reason, "capped at 4 by the org's limits");
  eq('under the cap, yours', merge(org, { concurrency: 2 }).raw.concurrency, 2);
  eq('the built-in default is capped too', merge({ limits: { concurrency: 1 } }, {}).raw.concurrency, 1);
  eq("an org default over its own cap doesn't count as yours", ignoredKeys(merge({ ...org, config: { concurrency: 9 } }, {})), []);
}

// ---- runner, and the keys that disappear in a cluster
{
  const r = merge({}, { runner: 'process', linearApiKey: 'lin_api_x', remote: { ssh: 'vm' }, worktreeRoot: '/w', repo: '/r' });
  eq('none of them reach the config', Object.keys(r.raw), []);
  eq('each is named', ignoredKeys(r).sort(), ['linearApiKey', 'remote', 'repo', 'runner', 'worktreeRoot']);
}

// ---- lockable keys: org default, user override unless locked
{
  const org = { config: { autoSplit: false, ciAutofix: true, retentionDays: 14 }, locked: ['ciAutofix'] };
  const r = merge(org, { autoSplit: true, ciAutofix: false, retentionDays: 60 });
  eq('unlocked: yours', [r.raw.autoSplit, r.raw.retentionDays], [true, 60]);
  eq("locked: the org's", r.raw.ciAutofix, true);
  eq('locked, and named', ignoredKeys(r), ['ciAutofix']);
  eq('sources', [r.layers.sources.autoSplit, r.layers.sources.ciAutofix], ['you', 'org']);
  eq('unset by you: the org default', merge(org, {}).raw.autoSplit, false);
  eq("same value as a lock isn't a refusal", ignoredKeys(merge(org, { ciAutofix: true })), []);
  const bare = merge({ locked: ['stateSync'] }, { stateSync: false });
  eq("a lock on a key the org didn't set keeps the default", [bare.raw.stateSync, ignoredKeys(bare)], [undefined, ['stateSync']]);
}

// ---- user only
{
  const r = merge({ config: { editor: 'nano', notifications: false, linearApiKey: 'lin_api_x', repos: [] } }, { editor: 'vim' });
  eq("personal keys are yours: the org's is dropped", r.raw.editor, 'vim');
  eq("and the org's config can't carry a key or repos", ignoredKeys(r, 'org').sort(), ['editor', 'linearApiKey', 'notifications', 'repos']);
  check('nothing it held reaches the config', !('linearApiKey' in r.raw) && !('notifications' in r.raw));
}

// ---- loadConfig: the org file is read, and a missing one is fatal
{
  const here = dirname(fileURLToPath(import.meta.url));
  const tmp = mkdtempSync(join(tmpdir(), 'coli-org-'));
  try {
    mkdirSync(join(tmp, 'home', '.config', 'colinear'), { recursive: true });
    writeFileSync(join(tmp, 'home', '.config', 'colinear', 'config.json'), JSON.stringify({ concurrency: 9, agentPermissionMode: 'bypassPermissions' }));
    writeFileSync(
      join(tmp, 'org.json'),
      JSON.stringify({ users: { allow: ['*'] }, config: { agentPermissionMode: 'acceptEdits' }, limits: { concurrency: 2 }, repos: [{ name: 'api', url: 'https://github.com/example/api' }] }),
    );
    const load = (org: string) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', '-e', `import('${join(here, 'config.ts')}').then(m => { const c = m.loadConfig(); console.log(JSON.stringify({ c: c.concurrency, p: c.agentPermissionMode, r: c.repos.map(r => [r.name, r.github]), l: c.layers })) })`],
        { env: { ...process.env, HOME: join(tmp, 'home'), COLINEAR_STATE_DIR: join(tmp, 'state'), COLINEAR_ORG_CONFIG: org, LINEAR_API_KEY: '' }, encoding: 'utf8' },
      );
    const ok = load(join(tmp, 'org.json'));
    const got = JSON.parse(ok.stdout.trim().split('\n').pop() || '{}');
    eq('loadConfig applies the org file', [got.c, got.p, got.r], [2, 'acceptEdits', [['api', 'example/api']]]);
    eq('and reports it', got.l?.org, join(tmp, 'org.json'));
    eq("needs no Linear key under an org", ok.status, 0);
    const missing = load(join(tmp, 'nowhere.json'));
    check('a missing org file is fatal, not ignored', missing.status !== 0 && /org config should be at/.test(missing.stderr), missing.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error(`org layer: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('org layer: ok — repos, tracker and runner are the org\'s; locks, stricter-only modes, unioned deny rules and capped concurrency hold');
