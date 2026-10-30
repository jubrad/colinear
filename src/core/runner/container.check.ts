/**
 * A session's container sees its worktree and nothing else of yours.
 *
 * Starts a real container runner from an image built from this repository
 * (`bin/check-container` builds it), serves a temporary worktree from it, and
 * checks the Workspace contract there, then the sandbox itself: what is
 * mounted, what isn't, who files belong to, where credentials land, and that
 * commits made inside reach the repository. No agent runs.
 *
 * Needs Docker. Run with `bin/check-container`, which builds the image and
 * then runs this; COLI_RUNNER_IMAGE names another image.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../types.js';
import { workspaceContract } from '../workspace.contract.js';
import { CONTAINER_CREDENTIALS } from './container.js';
import { spawnContainerRunner } from './container.js';
import { settableCredentials } from './credentials.js';
import { runnerWorkspace } from './workspace.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const image = process.env.COLI_RUNNER_IMAGE || 'colinear-runner:check';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'coli-container-check-')));
const cfg = { linearApiKey: 'lin_api_not_for_containers', repos: [] } as unknown as Config;

try {
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, '-c', 'user.email=check@example.invalid', '-c', 'user.name=check', 'commit', '-q', '--allow-empty', '-m', 'first');
  const worktree = join(root, 'trees', 'ENG-1');
  mkdirSync(join(root, 'trees'));
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'coli/eng-1');
  // beside the worktree, never mounted: the container must not be able to read it
  const secret = join(root, 'secret.txt');
  writeFileSync(secret, 'only on the host');
  const transcripts = join(root, 'transcripts', 'eng-1');

  const credentials = settableCredentials({ files: [{ path: 'claude/.credentials.json', content: '{"accessToken":"short-lived"}' }] });
  const link = await spawnContainerRunner(cfg, { image, worktree, transcripts: { host: transcripts, name: 'eng-1' } }, credentials);
  const ws = runnerWorkspace(link, worktree);

  await workspaceContract('in a container', ws, check);

  const sh = async (cmd: string) => ws.exec(['sh', '-c', cmd]);
  check('the worktree is at the same path inside', (await sh('pwd')).stdout.trim() === worktree);
  check('a file beside the worktree is not there', (await sh(`cat ${secret}`)).code !== 0);
  check('nor is your home directory', (await sh(`test -e ${JSON.stringify(process.env.HOME ?? '/Users')}`)).code !== 0);
  check('nor the Docker socket', (await sh('test -e /var/run/docker.sock')).code !== 0);
  check('it runs as you', (await sh('id -u')).stdout.trim() === String(process.getuid?.()));
  check('with no capabilities', /CapEff:\s*0+\s*$/m.test((await sh('cat /proc/self/status')).stdout));

  await ws.writeFile('made-inside.txt', 'x');
  check('files it makes are yours on the host', statSync(join(worktree, 'made-inside.txt')).uid === process.getuid?.());

  const commit = await ws.exec(['git', '-c', 'user.email=agent@example.invalid', '-c', 'user.name=agent', 'commit', '--allow-empty', '-m', 'from inside']);
  check('a commit made inside succeeds', commit.code === 0, commit.output);
  check('and lands in the repository', git(worktree, 'log', '-1', '--format=%s') === 'from inside');

  const creds = await sh(`cat ${CONTAINER_CREDENTIALS}/claude/.credentials.json`);
  check('pushed credentials are there for the agent', creds.stdout === '{"accessToken":"short-lived"}', creds.output);
  check('in memory, not on a disk you have', /tmpfs/.test((await sh(`grep ' ${CONTAINER_CREDENTIALS} ' /proc/mounts`)).stdout));
  check('the config it was sent has no tracker key', !(await sh('env')).stdout.includes('lin_api_not_for_containers'));

  credentials.set({ files: [{ path: 'claude/.credentials.json', content: '{"accessToken":"renewed"}' }] });
  let renewed = '';
  for (let i = 0; i < 40 && renewed !== '{"accessToken":"renewed"}'; i++) {
    renewed = (await sh(`cat ${CONTAINER_CREDENTIALS}/claude/.credentials.json`)).stdout;
    if (renewed !== '{"accessToken":"renewed"}') await new Promise((r) => setTimeout(r, 50));
  }
  check('a renewal reaches the running container', renewed === '{"accessToken":"renewed"}', renewed);

  await sh('echo "{}" > "$CLAUDE_CONFIG_DIR/projects/eng-1/session.jsonl"');
  check("the agent's transcripts land on the host, for resume and `s`", existsSync(join(transcripts, 'session.jsonl')));
  check('and are yours', statSync(join(transcripts, 'session.jsonl')).uid === process.getuid?.());
  check('the agent can write the rest of its config', (await sh('mkdir -p "$CLAUDE_CONFIG_DIR/todos" && touch "$CLAUDE_CONFIG_DIR/settings.json"')).code === 0);

  link.close();
} catch (err) {
  failures.push(`threw: ${String(err)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`container: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log("ok — a session's container sees its worktree and nothing else of yours, runs as you with no\n     capabilities, keeps credentials in memory, and its commits and transcripts reach the host");
process.exit(0);
