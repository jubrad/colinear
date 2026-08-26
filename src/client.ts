import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './core/config.js';
import { STATE_DIR, log } from './core/log.js';
import {
  createDecoder,
  encode,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  type ClientMsg,
  type Command,
  type ServerMsg,
} from './core/protocol.js';
import type { ChannelMessage } from './core/channel.js';
import { store } from './core/store.js';
import { openTunnel } from './core/tunnel.js';
import type { AgentSession } from './core/sessions.js';
import type { ProjectBrief } from './core/newproject.js';
import type { Config, Issue, RepoConfig, TaskEdits } from './core/types.js';

/**
 * What the views call. The daemon implements it for real; the client just
 * ships the call over the socket and lets the resulting deltas land.
 */
export interface DispatcherApi {
  enqueue(
    issues: Issue[],
    opts?: { instructions?: string; model?: string; repo?: RepoConfig; skipTriage?: boolean; manual?: boolean },
  ): void;
  cancel(id: string): boolean;
  resume(id: string): boolean;
  /** start a blocked task now, keeping its blockers as merge-order deps */
  force(id: string): boolean;
  /** rebase a conflicting PR onto its base */
  rebase(id: string): void;
  suspend(id: string): boolean;
  redispatch(id: string, repo: RepoConfig, opts?: { retriage?: boolean; skipTriage?: boolean }): boolean;
  pollPrs(): Promise<void>;
  applyEdits(id: string, edits: TaskEdits): void;
  setViewer(viewer: { id: string; displayName: string }): void;
  reloadConfig(): void;
  /** PR review flow — see Reviewer; nothing reaches GitHub until asked */
  startReview(id: string): void;
  cancelReview(id: string): void;
  suspendReview(id: string): void;
  reviewChat(id: string, text: string): void;
  reloadReviewDoc(id: string): void;
  postReview(id: string): void;
  reviewVerdict(id: string, verdict: 'approve' | 'request-changes'): void;
  pollReviews(): void;
  /** project plans — the design doc drafted here, owned by the tracker */
  startPlan(projectId: string): void;
  planChat(projectId: string, text: string): void;
  reloadPlanDoc(projectId: string): void;
  publishPlan(projectId: string): void;
  approvePlan(projectId: string, drop: string[], dispatch: boolean): void;
  removePlan(projectId: string): void;
  postPlanUpdate(projectId: string): void;
  startPlanChat(projectId: string): void;
  listAgents(): void;
  reviewDiff(id: string): void;
  taskDiff(id: string): void;
  explainLines(id: string, file: string, startLine: number, endLine: number): void;
  reviewTask(id: string): void;
  editTaskFinding(id: string, file: string, line: number, comment: string, severity?: string, startLine?: number): void;
  sendFindings(id: string): void;
  editFinding(id: string, file: string, line: number, comment: string, severity?: string, startLine?: number): void;
  createIssue(scopeId: string, request: string): void;
  createProject(brief: ProjectBrief): void;
  gcScan(olderThanDays: number): void;
  /** submit answers to a pending question set (used by the $EDITOR path) */
  answer(id: string, answers: string[]): void;
  /** say something to a task's agent without attaching (live push, else queued);
      wake:false queues it instead of starting a session to read it */
  message(id: string, text: string, opts?: { wake?: boolean }): void;
  /** EXPERIMENTAL: operator message onto a coordination channel */
  channelPost(channel: string, text: string): void;
  /** ask the daemon for things that live on its disk (see onLogTail etc.) */
  requestLogTail(bytes?: number): void;
  requestChannels(): void;
  requestChannelHistory(channel: string): void;
  gcRemove(paths: string[]): void;
}

export interface GcItem {
  path: string;
  kilobytes: number;
  label: string;
  reason: string;
  ageDays: number;
}

export interface GcProgress {
  done: number;
  total: number;
  path: string;
  ok: boolean;
  finished: boolean;
}

/** A design session the daemon has prepared: where it lives, and how to enter it. */
export interface PlanChatReady {
  projectId: string;
  worktree: string;
  sessionId: string;
  /** true: start this id with `primer` · false: resume the existing conversation */
  fresh: boolean;
  primer?: string;
}

export interface Connection {
  cfg: Config;
  /** results of a gcScan; returns an unsubscribe */
  onGc(fn: (items: GcItem[]) => void): () => void;
  /** per-worktree progress while gcRemove runs; returns an unsubscribe */
  onGcProgress(fn: (p: GcProgress) => void): () => void;
  onPlanChatReady(fn: (r: PlanChatReady) => void): () => void;
  onAgents(fn: (list: AgentSession[]) => void): () => void;
  onReviewDiff(fn: (id: string, diff: string) => void): () => void;
  onTaskDiff(fn: (id: string, diff: string) => void): () => void;
  onCreating(fn: (agentId: string) => void): () => void;
  /** daemon-side messages (edit results, etc.); returns an unsubscribe */
  onToast(fn: (text: string, kind: 'info' | 'ok' | 'err') => void): () => void;
  /** the daemon's log tail, in reply to requestLogTail */
  onLogTail(fn: (text: string) => void): () => void;
  /** channel list / one channel's history, in reply to the matching request */
  onChannels(fn: (list: Array<{ name: string; messages: number }>) => void): () => void;
  onChannelHistory(fn: (channel: string, messages: ChannelMessage[]) => void): () => void;
  /** something worth surfacing on whichever machine has a screen */
  onNotify(fn: (n: { title: string; body: string; url?: string }) => void): () => void;
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

/** Whatever the daemon last refused to start over, if it said so recently. */
function recentFatal(): string {
  try {
    const lines = readFileSync(join(STATE_DIR, 'colinear.log'), 'utf8').trimEnd().split('\n');
    const last = lines.filter((l) => l.includes('fatal:')).at(-1);
    if (!last) return '';
    const [stamp] = last.split(' ');
    // only if it's from this attempt — an old failure would be a red herring
    if (Date.now() - Date.parse(stamp) > 60_000) return '';
    return `\n\n  ${last.slice(last.indexOf('fatal:') + 7).trim()}\n`;
  } catch {
    return '';
  }
}

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
  // set when we opened the tunnel: it is ours to take down again
  let closeTunnel: (() => void) | undefined;
  if (!socket) {
    // A context whose daemon lives elsewhere must never get a local one
    // started under it: you'd end up with two daemons, or a local one holding
    // a socket the real work isn't behind.
    const remote = loadConfig({ requireKey: false }).remote;
    if (remote) {
      if (remote.forward) {
        // the socket is missing because nothing is forwarding it yet: open the
        // tunnel ourselves and try again
        const tunnel = await openTunnel(remote, SOCKET_PATH);
        if (tunnel) {
          socket = await tryConnect();
          if (socket) closeTunnel = tunnel.close;
        }
      }
      if (!socket) {
        throw new Error(
          `no daemon behind ${SOCKET_PATH}, and this context runs on ${remote.label}.\n` +
            (remote.forward
              ? `The tunnel did not come up — check ${join(STATE_DIR, 'colinear.log')}, and that ` +
                `\`ssh ${remote.ssh} 'coli daemon status'\` reports one running.`
              : 'Start it there (or open the tunnel) — colinear will not start a local one for a remote context.'),
        );
      }
    }
    // a socket file left by a killed daemon refuses connections forever
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    spawnDaemon();
    // 10s, not the 2s this used to allow: a cold daemon on a loaded machine
    // (or under tsx in dev) can take several seconds to reach listen(), and
    // failing there tells the operator colinear is broken when it is merely slow
    for (let i = 0; i < 100 && !socket; i++) {
      await sleep(100);
      socket = await tryConnect();
    }
  }
  if (!socket) {
    // the daemon we just spawned is detached with stdio ignored, so its own
    // reason for dying is only in the log — quote it rather than making the
    // operator go and find it
    throw new Error(
      `could not reach or start the colinear daemon (${SOCKET_PATH}).${recentFatal()}\n` +
        `Run \`coli daemon\` in the foreground for the full output, or check ${join(STATE_DIR, 'colinear.log')}.`,
    );
  }

  socket.setEncoding('utf8');
  socket.setNoDelay(true);
  const send = (msg: ClientMsg) => {
    socket?.write(encode(msg));
  };
  // returns void deliberately: these are called straight from effects and
  // handlers, and a stray return value gets mistaken for a cleanup function
  const command = (cmd: Command) => send({ t: 'cmd', cmd });

  const toastListeners = new Set<(text: string, kind: 'info' | 'ok' | 'err') => void>();
  const logListeners = new Set<(text: string) => void>();
  const channelListeners = new Set<(list: Array<{ name: string; messages: number }>) => void>();
  const historyListeners = new Set<(channel: string, messages: ChannelMessage[]) => void>();
  const notifyListeners = new Set<(n: { title: string; body: string; url?: string }) => void>();
  const gcListeners = new Set<(items: GcItem[]) => void>();
  const gcProgressListeners = new Set<(p: GcProgress) => void>();
  const planChatListeners = new Set<(r: PlanChatReady) => void>();
  const agentListeners = new Set<(list: AgentSession[]) => void>();
  const diffListeners = new Set<(id: string, diff: string) => void>();
  const taskDiffListeners = new Set<(id: string, diff: string) => void>();
  const creatingListeners = new Set<(agentId: string) => void>();

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
          (id, answers) => command({ name: 'answer', id, answers }),
        );
        ready = true;
        resolve({
          cfg: msg.cfg,
          daemonPid: msg.pid,
          close: () => {
            socket?.destroy();
            // a forward we opened outlives the socket otherwise, leaving a
            // path that accepts connections with nothing behind it
            closeTunnel?.();
          },
          onToast: (fn) => {
            toastListeners.add(fn);
            return () => toastListeners.delete(fn);
          },
          onLogTail: (fn) => {
            logListeners.add(fn);
            return () => logListeners.delete(fn);
          },
          onChannels: (fn) => {
            channelListeners.add(fn);
            return () => channelListeners.delete(fn);
          },
          onChannelHistory: (fn) => {
            historyListeners.add(fn);
            return () => historyListeners.delete(fn);
          },
          onNotify: (fn) => {
            notifyListeners.add(fn);
            return () => notifyListeners.delete(fn);
          },
          onGc: (fn) => {
            gcListeners.add(fn);
            return () => gcListeners.delete(fn);
          },
          onPlanChatReady: (fn) => {
            planChatListeners.add(fn);
            return () => planChatListeners.delete(fn);
          },
          onAgents: (fn) => {
            agentListeners.add(fn);
            return () => agentListeners.delete(fn);
          },
          onReviewDiff: (fn) => {
            diffListeners.add(fn);
            return () => diffListeners.delete(fn);
          },
          onTaskDiff: (fn) => {
            taskDiffListeners.add(fn);
            return () => taskDiffListeners.delete(fn);
          },
          onCreating: (fn) => {
            creatingListeners.add(fn);
            return () => creatingListeners.delete(fn);
          },
          onGcProgress: (fn) => {
            gcProgressListeners.add(fn);
            return () => gcProgressListeners.delete(fn);
          },
          dispatcher: {
            enqueue: (issues, opts) => command({ name: 'enqueue', issues, opts }),
            cancel: (id) => (command({ name: 'cancel', id }), true),
            resume: (id) => (command({ name: 'resume', id }), true),
            force: (id) => (command({ name: 'force', id }), true),
            rebase: (id) => command({ name: 'rebase', id }),
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
            suspendReview: (id) => command({ name: 'suspendReview', id }),
            reviewChat: (id, text) => command({ name: 'reviewChat', id, text }),
            reloadReviewDoc: (id) => command({ name: 'reloadReviewDoc', id }),
            postReview: (id) => command({ name: 'postReview', id }),
            reviewVerdict: (id, verdict) => command({ name: 'reviewVerdict', id, verdict }),
            pollReviews: () => command({ name: 'pollReviews' }),
          startPlan: (projectId) => command({ name: 'startPlan', projectId }),
          planChat: (projectId, text) => command({ name: 'planChat', projectId, text }),
          reloadPlanDoc: (projectId) => command({ name: 'reloadPlanDoc', projectId }),
          publishPlan: (projectId) => command({ name: 'publishPlan', projectId }),
          approvePlan: (projectId, drop, dispatch) => command({ name: 'approvePlan', projectId, drop, dispatch }),
          removePlan: (projectId) => command({ name: 'removePlan', projectId }),
          postPlanUpdate: (projectId) => command({ name: 'postPlanUpdate', projectId }),
          startPlanChat: (projectId) => command({ name: 'startPlanChat', projectId }),
          listAgents: () => command({ name: 'listAgents' }),
          reviewDiff: (id) => command({ name: 'reviewDiff', id }),
          taskDiff: (id) => command({ name: 'taskDiff', id }),
          explainLines: (id, file, startLine, endLine) =>
            command({ name: 'explainLines', id, file, startLine, endLine }),
          reviewTask: (id) => command({ name: 'reviewTask', id }),
          editTaskFinding: (id, file, line, comment, severity, startLine) =>
            command({ name: 'editTaskFinding', id, file, line, comment, severity, startLine }),
          sendFindings: (id) => command({ name: 'sendFindings', id }),
          editFinding: (id, file, line, comment, severity, startLine) =>
            command({ name: 'editFinding', id, file, line, comment, severity, startLine }),
          createIssue: (scopeId, request) => command({ name: 'createIssue', scopeId, request }),
          createProject: (brief) => command({ name: 'createProject', brief }),
            gcScan: (olderThanDays) => command({ name: 'gcScan', olderThanDays }),
            answer: (id, answers) => command({ name: 'answer', id, answers }),
            message: (id, text, opts) => command({ name: 'message', id, text, wake: opts?.wake }),
            channelPost: (channel, text) => command({ name: 'channelPost', channel, text }),
            requestLogTail: (bytes) => command({ name: 'logTail', bytes }),
            requestChannels: () => command({ name: 'channelList' }),
            requestChannelHistory: (channel) => command({ name: 'channelHistory', channel }),
            gcRemove: (paths) => command({ name: 'gcRemove', paths }),
          },
        });
      } else if (msg.t === 'taskDiff') {
        for (const fn of taskDiffListeners) fn(msg.id, msg.diff);
      } else if (msg.t === 'reviewDiff') {
        for (const fn of diffListeners) fn(msg.id, msg.diff);
      } else if (msg.t === 'agents') {
        for (const fn of agentListeners) fn(msg.list);
      } else if (msg.t === 'creating') {
        for (const fn of creatingListeners) fn(msg.agentId);
      } else if (msg.t === 'planChatReady') {
        for (const fn of planChatListeners) fn(msg);
      } else if (msg.t === 'gcProgress') {
        for (const fn of gcProgressListeners) fn(msg);
      } else if (msg.t === 'gc') {
        for (const fn of gcListeners) fn(msg.items);
      } else if (msg.t === 'toast') {
        for (const fn of toastListeners) fn(msg.text, msg.kind);
      } else if (msg.t === 'logTail') {
        for (const fn of logListeners) fn(msg.text);
      } else if (msg.t === 'channels') {
        for (const fn of channelListeners) fn(msg.list);
      } else if (msg.t === 'channelHistory') {
        for (const fn of historyListeners) fn(msg.channel, msg.messages);
      } else if (msg.t === 'notify') {
        for (const fn of notifyListeners) fn(msg);
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
      closeTunnel?.();
      if (!ready) reject(new Error('daemon closed the connection during handshake'));
    });
    socket?.on('error', (err) => {
      if (!ready) reject(err);
      else log(`client socket error: ${err}`);
    });
  });
}
