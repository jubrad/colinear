import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { log } from './log.js';
import type { Config } from './types.js';

/**
 * The ssh tunnel to a remote daemon's socket.
 *
 * colinear speaks NDJSON over a unix socket and OpenSSH forwards unix sockets,
 * so a remote daemon needs no protocol work — only for the socket to exist at
 * the path this context already looks in. That used to be a command you ran in
 * another window and remembered to keep alive; `"forward": true` makes it
 * colinear's job.
 *
 * The tunnel is a child process, not a daemon: it dies with the session that
 * opened it. Leaving a forward running after the UI exits would leave a socket
 * that answers but has nobody behind it, which is worse than no socket at all.
 */

type Remote = NonNullable<Config['remote']>;

/**
 * Where the daemon's socket lives on the far side. Configured wins; otherwise
 * ask it, because the answer depends on that machine's HOME and context and
 * guessing it wrong produces a tunnel that connects to nothing.
 */
export function remoteSocketPath(remote: Remote): string | undefined {
  if (remote.socket) return remote.socket;
  if (!remote.ssh) return undefined;
  // no -t: a tty would wrap the answer in carriage returns
  const probe = spawnSync('ssh', [remote.ssh, 'coli daemon socket'], { encoding: 'utf8', timeout: 15_000 });
  const path = probe.stdout?.trim().split('\n').pop()?.trim();
  if (probe.status !== 0 || !path?.startsWith('/')) {
    log(`tunnel: could not ask ${remote.label} where its socket is: ${(probe.stderr || probe.stdout || '').trim()}`);
    return undefined;
  }
  return path;
}

export interface Tunnel {
  close(): void;
}

/**
 * Forward `localPath` to the daemon's socket on the remote, and resolve once
 * something answers there. Returns undefined if it never came up — the caller
 * reports that, since it has the context to say what to try next.
 */
export async function openTunnel(remote: Remote, localPath: string): Promise<Tunnel | undefined> {
  if (!remote.ssh) return undefined;
  const remotePath = remoteSocketPath(remote);
  if (!remotePath) return undefined;

  // ssh refuses to bind a forward onto an existing file, and a socket left by
  // a dead tunnel is exactly that. Safe to remove: a context with a remote
  // never has a local daemon behind this path.
  if (existsSync(localPath)) unlinkSync(localPath);

  const args = ['-N', '-L', `${localPath}:${remotePath}`, remote.ssh];
  log(`tunnel: ssh ${args.join(' ')}`);
  const child = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
    log(`tunnel: ${chunk.trim()}`);
  });

  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    if (code) log(`tunnel: ssh exited with ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
  });

  const close = () => {
    if (!child.killed) child.kill('SIGTERM');
    try {
      if (existsSync(localPath)) unlinkSync(localPath);
    } catch {
      /* the socket is ssh's to remove; ours is a best effort */
    }
  };
  // the tunnel belongs to this process: don't outlive it, in either direction
  process.once('exit', close);

  // ssh has to authenticate and bind before anything can connect; 10s matches
  // the patience the local daemon spawn already gets
  for (let i = 0; i < 100; i++) {
    if (exited) return undefined;
    if (await answers(localPath)) return { close };
    await sleep(100);
  }
  close();
  return undefined;
}

function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
