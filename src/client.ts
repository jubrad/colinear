import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { log } from './core/log.js';
import {
  createDecoder,
  encode,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  type ClientMsg,
  type Command,
  type ServerMsg,
} from './core/protocol.js';
import { store } from './core/store.js';
import type { Config, LinearIssue, RepoConfig, TaskEdits } from './core/types.js';

/**
 * What the views call. The daemon implements it for real; the client just
 * ships the call over the socket and lets the resulting deltas land.
 */
export interface DispatcherApi {
  enqueue(
    issues: LinearIssue[],
    opts?: { instructions?: string; model?: string; repo?: RepoConfig; skipTriage?: boolean },
  ): void;
  cancel(id: string): boolean;
  resume(id: string): boolean;
  suspend(id: string): boolean;
  redispatch(id: string, repo: RepoConfig, opts?: { retriage?: boolean; skipTriage?: boolean }): boolean;
  pollPrs(): Promise<void>;
  applyEdits(id: string, edits: TaskEdits): void;
  setViewer(viewer: { id: string; displayName: string }): void;
  reloadConfig(): void;
  /** PR review flow — see Reviewer; nothing reaches GitHub until asked */
  startReview(id: string): void;
  cancelReview(id: string): void;
  postReview(id: string): void;
  reviewVerdict(id: string, verdict: 'approve' | 'request-changes'): void;
  pollReviews(): void;
}

export interface Connection {
  cfg: Config;
  /** daemon-side messages (edit results, etc.); returns an unsubscribe */
  onToast(fn: (text: string, kind: 'info' | 'ok' | 'err') => void): () => void;
  dispatcher: DispatcherApi;
  daemonPid: number;
  close(): void;
}

const daemonScript = () =>
  fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './index.tsx' : './index.js', import.meta.url));

/** Start a detached daemon that outlives this process (and this terminal). */
function spawnDaemon(): void {
  // execArgv carries the loader in dev (tsx), where the entry point is .tsx
  const child = spawn(process.execPath, [...process.execArgv, daemonScript(), 'daemon'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log(`spawned daemon pid ${child.pid}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tryConnect(): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(SOCKET_PATH);
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

/**
 * Attach to the daemon, starting one if it isn't up, and turn the local store
 * into a mirror of its state. Returns once the first snapshot has landed.
 */
export async function connectToDaemon(): Promise<Connection> {
  let socket = await tryConnect();
  if (!socket) {
    // a socket file left by a killed daemon refuses connections forever
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    spawnDaemon();
    for (let i = 0; i < 40 && !socket; i++) {
      await sleep(50);
      socket = await tryConnect();
    }
  }
  if (!socket) throw new Error(`could not reach or start the colinear daemon (${SOCKET_PATH})`);

  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  const send = (msg: ClientMsg) => socket?.write(encode(msg));
  const command = (cmd: Command) => send({ t: 'cmd', cmd });

  const toastListeners = new Set<(text: string, kind: 'info' | 'ok' | 'err') => void>();

  return await new Promise<Connection>((resolve, reject) => {
    let ready = false;
    const decode = createDecoder<ServerMsg>((msg) => {
      if (msg.t === 'hello') {
        if (msg.protocol !== PROTOCOL_VERSION) {
          reject(
            new Error(
              `daemon speaks protocol ${msg.protocol}, this client speaks ${PROTOCOL_VERSION}. ` +
                'Restart it: coli daemon stop && coli',
            ),
          );
          return;
        }
        store.hydrate(msg.snapshot);
        store.attach(
          (change) => command({ name: 'change', change }),
          (id, text) => command({ name: 'answer', id, text }),
        );
        ready = true;
        resolve({
          cfg: msg.cfg,
          daemonPid: msg.pid,
          close: () => socket?.destroy(),
          onToast: (fn) => {
            toastListeners.add(fn);
            return () => toastListeners.delete(fn);
          },
          dispatcher: {
            enqueue: (issues, opts) => command({ name: 'enqueue', issues, opts }),
            cancel: (id) => (command({ name: 'cancel', id }), true),
            resume: (id) => (command({ name: 'resume', id }), true),
            suspend: (id) => (command({ name: 'suspend', id }), true),
            redispatch: (id, repo, opts) => (command({ name: 'redispatch', id, repo, opts }), true),
            pollPrs: async () => {
              command({ name: 'pollPrs' });
            },
            applyEdits: (id, edits) => command({ name: 'applyEdits', id, edits }),
            setViewer: (viewer) => command({ name: 'setViewer', viewer }),
            reloadConfig: () => command({ name: 'reloadConfig' }),
            startReview: (id) => command({ name: 'startReview', id }),
            cancelReview: (id) => command({ name: 'cancelReview', id }),
            postReview: (id) => command({ name: 'postReview', id }),
            reviewVerdict: (id, verdict) => command({ name: 'reviewVerdict', id, verdict }),
            pollReviews: () => command({ name: 'pollReviews' }),
          },
        });
      } else if (msg.t === 'toast') {
        for (const fn of toastListeners) fn(msg.text, msg.kind);
      } else if (msg.t === 'snapshot') {
        store.hydrate(msg.snapshot);
      } else if (msg.t === 'delta') {
        // a rejected delta means we missed one — ask for the tail we're due
        if (!store.apply(msg.delta)) send({ t: 'sync', version: store.version });
      }
    });
    socket?.on('data', (chunk: string) => {
      try {
        decode(chunk);
      } catch (err) {
        log(`client: bad message from daemon: ${err}`);
      }
    });
    socket?.on('close', () => {
      if (!ready) reject(new Error('daemon closed the connection during handshake'));
    });
    socket?.on('error', (err) => {
      if (!ready) reject(err);
      else log(`client socket error: ${err}`);
    });
  });
}
