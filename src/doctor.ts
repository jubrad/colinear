import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { loadConfig } from './core/config.js';
import { fetchIssues, fetchViewer } from './core/linear.js';

const exec = promisify(execFile);

const ok = (name: string, detail: string) => console.log(`  ✔ ${name}: ${detail}`);
const bad = (name: string, detail: string) => {
  console.log(`  ✖ ${name}: ${detail}`);
  failures++;
};
let failures = 0;

console.log('foreman doctor\n');
const cfg = loadConfig();

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

if (existsSync(`${cfg.repo}/.git`)) ok('repo', cfg.repo);
else bad('repo', `${cfg.repo} is not a git repository (set "repo" in config)`);

if (process.env.ANTHROPIC_API_KEY) {
  console.log('  ⚠ ANTHROPIC_API_KEY is set — agents will bill the API key, not your subscription');
}

try {
  const viewer = await fetchViewer(cfg);
  ok('Linear auth', viewer.displayName);
  const issues = await fetchIssues(cfg, cfg.team);
  ok('Linear issues', `${issues.length} in ${cfg.team === '*' ? 'all teams' : (cfg.team ?? 'my queue')}`);
  for (const i of issues.slice(0, 10)) console.log(`      ${i.identifier}  [${i.stateName}]  ${i.title}`);
} catch (err) {
  bad('Linear', String(err));
}

console.log(failures ? `\n${failures} problem(s) found` : '\nall good — run `npm run dev`');
process.exit(failures ? 1 : 0);
