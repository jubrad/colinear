import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { log } from '../log.js';
import type { Config } from '../types.js';
import { handshake, type RunnerLink } from './backend.js';
import type { CredentialSource } from './credentials.js';
import { streamLink } from './link.js';

const exec = promisify(execFile);

/** Inside the container: where pushed credentials go (memory only), and the agent's config. */
export const CONTAINER_CREDENTIALS = '/run/coli/creds';
export const CONTAINER_HOME = '/home/runner';
export const CONTAINER_AGENT_CONFIG = `${CONTAINER_HOME}/.claude`;

export interface ContainerSpec {
  image: string;
  /** the worktree, mounted at the same path so prompts and cwd don't change */
  worktree: string;
  /** the repository's shared git dir, where a linked worktree's commits actually go */
  gitCommonDir?: string;
  /** this worktree's transcripts on the host, so `s` and resume work from outside */
  transcripts?: { host: string; name: string };
  uid: number;
  gid: number;
}

/**
 * `docker run` for one session: what the container can see, and nothing else.
 *
 * Mounted: the worktree, the repository's shared git dir (a linked worktree's
 * objects and refs live there), and this worktree's own transcript directory.
 * Not mounted: your home directory, other worktrees, your credentials, the
 * Docker socket. Credentials arrive pushed, into memory. The agent's home is
 * memory too, and goes when the container does.
 */
export function containerArgs(spec: ContainerSpec): string[] {
  const owner = `uid=${spec.uid},gid=${spec.gid}`;
  return [
    'run', '--rm', '-i', '--init',
    '--user', `${spec.uid}:${spec.gid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', `${CONTAINER_HOME}:${owner},mode=0700`,
    '--tmpfs', `${CONTAINER_CREDENTIALS}:${owner},mode=0700`,
    // its own mount, so it is yours: docker makes the directories above a bind
    // mount as root, and the agent writes its settings here beside the transcripts
    '--tmpfs', `${CONTAINER_AGENT_CONFIG}:${owner},mode=0700`,
    '-e', `HOME=${CONTAINER_HOME}`,
    '-e', `CLAUDE_CONFIG_DIR=${CONTAINER_AGENT_CONFIG}`,
    '-e', `COLINEAR_RUNNER_CREDENTIALS=${CONTAINER_CREDENTIALS}`,
    '-v', `${spec.worktree}:${spec.worktree}`,
    ...(spec.gitCommonDir ? ['-v', `${spec.gitCommonDir}:${spec.gitCommonDir}`] : []),
    ...(spec.transcripts ? ['-v', `${spec.transcripts.host}:${CONTAINER_AGENT_CONFIG}/projects/${spec.transcripts.name}`] : []),
    '-w', spec.worktree,
    spec.image,
    'coli', 'runner',
  ];
}

/** The repository's shared git dir for a worktree, if it is one. */
export async function gitCommonDir(worktree: string): Promise<string | undefined> {
  const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => ({ stdout: '' }));
  return stdout.trim() || undefined;
}

/**
 * A runner in a container, for one session: `"runner": { "container": image }`.
 * Speaks the same frames as a child process, over `docker run -i`'s stdio.
 */
export async function spawnContainerRunner(
  cfg: Config,
  spec: Omit<ContainerSpec, 'gitCommonDir' | 'uid' | 'gid'>,
  credentials?: CredentialSource,
): Promise<RunnerLink> {
  // docker makes a missing mount source itself, as root: make it first, as you
  if (spec.transcripts) mkdirSync(spec.transcripts.host, { recursive: true });
  const full: ContainerSpec = {
    ...spec,
    gitCommonDir: await gitCommonDir(spec.worktree),
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
  const child = spawn('docker', containerArgs(full), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => {
    stderr = (stderr + c).slice(-2_000);
  });
  child.on('exit', (code) => {
    if (code) log(`container runner for ${spec.worktree} exited ${code}: ${stderr.trim().slice(-300)}`);
  });
  const link: RunnerLink = streamLink(child.stdout, child.stdin, () => child.kill());
  return handshake(link, cfg, { workspace: spec.worktree, credentials, timeoutMs: 60_000 }).catch((err: unknown) => {
    // docker's own complaint is the useful part: no daemon, no image, a bad mount
    throw new Error(`${err instanceof Error ? err.message : String(err)}${stderr.trim() ? ` (docker: ${stderr.trim().slice(-200)})` : ''}`);
  });
}
