import { execFile } from 'node:child_process';
import { providerFor } from './core/provider.js';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { configPath, loadConfig } from './core/config.js';
import { CONTEXT, DEFAULT_CONTEXT } from './core/context.js';


const exec = promisify(execFile);

/** owner/repo for each remote — the same read `:reviews` matches PRs against. */
async function remoteSlugs(path: string): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'remote', '-v']);
    return [...new Set([...stdout.matchAll(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
}


const ok = (name: string, detail: string) => console.log(`  ✔ ${name}: ${detail}`);
const bad = (name: string, detail: string) => {
  console.log(`  ✖ ${name}: ${detail}`);
  failures++;
};
let failures = 0;

console.log('colinear doctor\n');
// requireKey would exit here, taking every other check with it — and a
// missing key is exactly the kind of thing doctor exists to report
const cfg = loadConfig({ requireKey: false });
// which config this run is checking — a green doctor against the wrong
// context answers a question nobody asked
console.log(`  · config: ${configPath()}${CONTEXT === DEFAULT_CONTEXT ? '' : ` (context ${CONTEXT})`}`);

try {
  const { stdout } = await exec('claude', ['--version']);
  ok('claude CLI', stdout.trim());
} catch {
  bad('claude CLI', 'not found on PATH — install Claude Code and run `claude login`');
}

try {
  await exec('gh', ['auth', 'status']);
  ok('gh CLI', 'authenticated');
} catch {
  bad('gh CLI', 'not authenticated — run `gh auth login`');
}

// Every configured repo, and the GitHub slugs it contributes — because that
// is what a PR is matched against. A path that doesn't exist contributes
// nothing and looks, from :reviews, exactly like a repo you never configured.
for (const repo of cfg.repos) {
  if (!existsSync(`${repo.path}/.git`)) {
    bad(`repo ${repo.name}`, `${repo.path} is not a git repository — fix its path in repos`);
    continue;
  }
  const slugs = await remoteSlugs(repo.path);
  if (slugs.length) ok(`repo ${repo.name}`, slugs.join(', '));
  else bad(`repo ${repo.name}`, `${repo.path} has no git remotes — PRs there can't be matched to it`);
}

if (process.env.ANTHROPIC_API_KEY) {
  console.log('  ⚠ ANTHROPIC_API_KEY is set — agents will bill the API key, not your subscription');
}

try {
  const viewer = await providerFor(cfg).viewer();
  ok('Linear auth', viewer.displayName);
  const issues = await providerFor(cfg).issues(cfg.team);
  ok('Linear issues', `${issues.length} in ${cfg.team === '*' ? 'all teams' : (cfg.team ?? 'my queue')}`);
  for (const i of issues.slice(0, 10)) console.log(`      ${i.identifier}  [${i.stateName}]  ${i.title}`);
} catch (err) {
  bad('Linear', String(err));
}

console.log(failures ? `\n${failures} problem(s) found` : '\nall good — run `npm run dev`');
process.exit(failures ? 1 : 0);
