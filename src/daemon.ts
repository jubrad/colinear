import { createServer, type Socket } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './core/config.js';
import { channels } from './core/channel.js';
import { isDemo, seedDemoBoard, seedDemoIssues } from './core/demo.js';
import { Dispatcher } from './core/dispatcher.js';
import { STATE_DIR, log } from './core/log.js';
import { onNotifyForward } from './core/notify.js';
import { loadState, startPersistence } from './core/persist.js';
import { startPrPolling } from './core/prs.js';
import { Reviewer } from './core/reviewer.js';
import { PlanManager } from './core/projectplan.js';
import { providerFor } from './core/provider.js';
import type { Project, Severity } from './core/types.js';
import { pollReviewRequests, startReviewPolling } from './core/reviews.js';
import {
  createDecoder,
  encode,
  PROTOCOL_VERSION,
  SOCKET_PATH,
  type ClientMsg,
  type Command,
  type ServerMsg,
} from './core/protocol.js';
import { findReclaimable, removeWorktree } from './core/gc.js';
import * as selfreview from './core/selfreview.js';
import { createIssueFromPrompt } from './core/newissue.js';
import { createProjectFromPrompt } from './core/newproject.js';
import { listSessions, updateSession } from './core/sessions.js';
import { store } from './core/store.js';

/** Liveness marker so `coli daemon status|stop` doesn't need the socket. */
/** The tail of this daemon's log, for a client that can't read its disk. */
function readLogTail(bytes: number): string {
  try {
    const file = join(STATE_DIR, 'colinear.log');
    const { size } = statSync(file);
    const start = Math.max(0, size - bytes);
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(bytes, size));
      const read = readSync(fd, buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, read).toString('utf8');
      return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return `could not read the daemon log: ${err}`;
  }
}

export const PID_PATH = join(STATE_DIR, 'coli.pid');

/**
 * The backend half: owns the dispatcher, the store, persistence, PR polling
 * and the Linear sweeps. Clients attach over a unix socket, hydrate from a
 * snapshot and follow the delta stream, so a TUI can come and go (or crash)
 * without touching a running agent.
 */
export async function runDaemon(): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = new Dispatcher(cfg);
  const reviewer = new Reviewer(cfg);
  const plans = new PlanManager(cfg, {
    enqueue: (issues) => dispatcher.enqueue(issues),
    message: (id, text) => dispatcher.message(id, text),
    cancel: (id) => dispatcher.cancel(id),
  });
  loadState(cfg);
  reviewer.resumeWatching(); // reviews restored from disk keep their live doc
  plans.resumeWatching();
  const stopPersistence = startPersistence();

  // demo mode fabricates a board and never reaches the network: polling would
  // ask `gh` about PRs that don't exist and wipe the fiction
  if (isDemo(cfg)) {
    seedDemoBoard(cfg);
    void seedDemoIssues(cfg).catch((err) => log(`demo seed: ${err}`));
    log('demo mode: fabricated board, scripted agents, no network');
  }
  const stopPrPolling = isDemo(cfg) ? () => {} : startPrPolling(cfg, dispatcher);
  const stopReviewPolling = isDemo(cfg)
    ? () => {}
    : startReviewPolling(cfg, async () => {
        // a poll is what discovers a PR is merged or taken, so cleanup follows it
        await reviewer.cleanupStale();
        // same cadence checks planned projects for outside design edits; the
        // one-sweep debounce below rides on this interval
        await plans.sweepDocChanges().catch((err) => log(`plan sweep: ${err}`));
      });

  const clients = new Set<Socket>();
  const broadcast = (msg: ServerMsg) => {
    const line = encode(msg);
    for (const socket of clients) socket.write(line);
  };

  dispatcher.onToast = (text, kind) => broadcast({ t: 'toast', text, kind });
  reviewer.onToast = (text, kind) => broadcast({ t: 'toast', text, kind });
  plans.onToast = (text, kind) => broadcast({ t: 'toast', text, kind });

  // every store mutation fans out to attached clients as a delta
  let sent = store.version;
  store.subscribe(() => {
    const deltas = store.since(sent);
    if (!deltas) {
      // a client can't be that far behind mid-session, but if the log wrapped
      // between notifications, resync everyone rather than skip changes
      broadcast({ t: 'snapshot', snapshot: store.snapshot() });
      sent = store.version;
      return;
    }
    for (const delta of deltas) broadcast({ t: 'delta', delta });
    sent = store.version;
  });

  /** `reply` answers just the client that asked; `broadcast` tells everyone. */
  const run = (cmd: Command, reply: (msg: ServerMsg) => void) => {
    switch (cmd.name) {
      case 'enqueue':
        dispatcher.enqueue(cmd.issues, cmd.opts);
        break;
      case 'cancel':
        dispatcher.cancel(cmd.id);
        break;
      case 'resume':
        dispatcher.resume(cmd.id);
        break;
      case 'force':
        dispatcher.force(cmd.id);
        break;
      case 'rebase':
        dispatcher.rebase(cmd.id);
        break;
      case 'suspend':
        dispatcher.suspend(cmd.id);
        break;
      case 'redispatch':
        dispatcher.redispatch(cmd.id, cmd.repo, cmd.opts);
        break;
      case 'answer': {
        // the callback lives here; the client only ever sends the text.
        // reviews are keyed "owner/repo#n", tasks by Linear id — no overlap
        const pending = store.get(cmd.id)?.question ?? store.getReview(cmd.id)?.question;
        pending?.answer(cmd.answers);
        break;
      }
      case 'applyEdits':
        void dispatcher.applyEdits(cmd.id, cmd.edits);
        break;
      case 'pollPrs':
        if (!isDemo(cfg)) void dispatcher.pollPrs();
        break;
      case 'setViewer':
        dispatcher.setViewer(cmd.viewer);
        break;
      case 'reloadConfig':
        Object.assign(cfg, loadConfig());
        log('config reloaded');
        break;
      case 'change':
        store.applyChange(cmd.change);
        break;
      case 'startReview':
        void reviewer.start(cmd.id);
        break;
      case 'cancelReview':
        reviewer.cancel(cmd.id);
        break;
      case 'suspendReview':
        reviewer.suspend(cmd.id);
        break;
      case 'reviewChat':
        void reviewer.chat(cmd.id, cmd.text);
        break;
      case 'reloadReviewDoc':
        reviewer.reloadDoc(cmd.id);
        break;
      case 'postReview':
        void reviewer.post(cmd.id);
        break;
      case 'reviewVerdict':
        void reviewer.verdict(cmd.id, cmd.verdict);
        break;
      case 'pollReviews':
        if (!isDemo(cfg)) void pollReviewRequests(cfg);
        break;
      case 'startPlan':
        void withProject(cmd.projectId, (project) => plans.start(project));
        break;
      case 'planChat':
        void plans.chat(cmd.projectId, cmd.text);
        break;
      case 'reloadPlanDoc':
        plans.reloadDraft(cmd.projectId);
        break;
      case 'publishPlan':
        void plans.publish(cmd.projectId);
        break;
      case 'approvePlan':
        void plans.approve(cmd.projectId, { drop: cmd.drop, dispatch: cmd.dispatch });
        break;
      case 'removePlan':
        plans.remove(cmd.projectId);
        break;
      case 'postPlanUpdate':
        void plans.postUpdate(cmd.projectId);
        break;
      case 'startPlanChat': {
        // the reply goes to the client that asked, once the worktree exists:
        // it is the one about to hand its terminal to claude
        const projectId = cmd.projectId;
        void withProject(projectId, async (project) => {
          // startChat decides fresh-vs-resume by looking for the transcript,
          // not by whether an id was once stored
          const ready = await plans.startChat(project);
          if (!ready) return;
          reply({
            t: 'planChatReady',
            projectId,
            worktree: ready.worktree,
            sessionId: ready.sessionId,
            fresh: ready.fresh,
            primer: ready.fresh ? await plans.chatPrimer(projectId) : undefined,
          });
        });
        break;
      }
      case 'message':
        dispatcher.message(cmd.id, cmd.text, { wake: cmd.wake });
        break;
      case 'explainLines': {
        // reviews are keyed "owner/repo#n" and tasks by tracker id, so which
        // one this is needs no extra flag — the same trick `answer` uses
        const at = { file: cmd.file, startLine: cmd.startLine, endLine: cmd.endLine };
        const task = store.get(cmd.id);
        if (task) void selfreview.explainLines(cfg, task, at);
        else if (store.getReview(cmd.id)) void reviewer.explainLines(cmd.id, at);
        break;
      }
      case 'taskDiff': {
        const task = store.get(cmd.id);
        if (task) void selfreview.taskDiff(cfg, task).then((diff) => reply({ t: 'taskDiff', id: cmd.id, diff }));
        break;
      }
      case 'reviewTask': {
        const task = store.get(cmd.id);
        // only on an open draft PR: the work is committed and the agent is
        // idle, so the diff being read is the diff that exists
        if (task?.status === 'pr_open') void selfreview.reviewTask(cfg, task);
        break;
      }
      case 'editTaskFinding': {
        const task = store.get(cmd.id);
        if (task) {
          selfreview.editFinding(
            task,
            { file: cmd.file, line: cmd.line },
            cmd.comment,
            cmd.severity as Severity | undefined,
          );
        }
        break;
      }
      case 'sendFindings': {
        const task = store.get(cmd.id);
        const handed = task && selfreview.handBack(task);
        if (!task || !handed) {
          broadcast({ t: 'toast', text: 'nothing to hand back — no findings to act on', kind: 'err' });
          break;
        }
        // maintenance, not a wake: waking would set the task back to `queued`
        // and drop it out of PR Open, which is not what happened
        if (!dispatcher.revise(task.issue.id, handed.text)) {
          broadcast({ t: 'toast', text: `${task.issue.identifier}: not idle on an open PR — nothing sent`, kind: 'err' });
          break;
        }
        broadcast({
          t: 'toast',
          text: `${task.issue.identifier}: ${handed.count} comment${handed.count === 1 ? '' : 's'} handed to the agent`,
          kind: 'ok',
        });
        break;
      }
      case 'reviewDiff':
        void reviewer.diff(cmd.id).then((diff) => reply({ t: 'reviewDiff', id: cmd.id, diff }));
        break;
      case 'editFinding':
        reviewer.editFinding(
          cmd.id,
          { file: cmd.file, line: cmd.line, startLine: cmd.startLine },
          cmd.comment,
          cmd.severity as Severity | undefined,
        );
        break;
      case 'listAgents':
        reply({ t: 'agents', list: listSessions() });
        break;
      case 'createIssue': {
        // Drafting runs here rather than in the TUI, so it survives `esc`, a
        // reload, and the terminal closing — and shows up in :agents like
        // every other agent. The client watches it there.
        let agentId: string | undefined;
        void (async () => {
          try {
            const issue = await createIssueFromPrompt(cfg, cmd.scopeId, cmd.request, undefined, (id) => {
              agentId = id;
              reply({ t: 'creating', agentId: id });
            });
            if (agentId) updateSession(agentId, { result: { ok: true, summary: `created ${issue.identifier}` } });
            broadcast({ t: 'toast', text: `created ${issue.identifier}`, kind: 'ok' });
          } catch (err) {
            if (agentId) updateSession(agentId, { result: { ok: false, summary: String(err).slice(0, 160) } });
            broadcast({ t: 'toast', text: `issue creation failed: ${String(err).slice(0, 80)}`, kind: 'err' });
          }
        })();
        break;
      }
      case 'createProject': {
        let agentId: string | undefined;
        void (async () => {
          try {
            const project = await createProjectFromPrompt(cfg, cmd.brief, undefined, (id) => {
              agentId = id;
              reply({ t: 'creating', agentId: id });
            });
            if (agentId) {
              updateSession(agentId, { result: { ok: true, summary: `created "${project.name}"`, url: project.url } });
            }
            broadcast({ t: 'toast', text: `created ${project.name}`, kind: 'ok' });
          } catch (err) {
            if (agentId) updateSession(agentId, { result: { ok: false, summary: String(err).slice(0, 160) } });
            broadcast({ t: 'toast', text: `project creation failed: ${String(err).slice(0, 80)}`, kind: 'err' });
          }
        })();
        break;
      }
      case 'logTail':
        reply({ t: 'logTail', text: readLogTail(cmd.bytes ?? 512 * 1024) });
        break;
      case 'channelList':
        reply({
          t: 'channels',
          list: channels.channels().map((name) => ({ name, messages: channels.history(name).length })),
        });
        break;
      case 'channelHistory':
        reply({ t: 'channelHistory', channel: cmd.channel, messages: channels.history(cmd.channel) });
        break;
      case 'channelPost':
        dispatcher.channelPost(cmd.channel, cmd.text);
        break;
      case 'gcScan':
        void findReclaimable(cfg, store.list(), store.listReviews(), store.listPlans(), cmd.olderThanDays).then((items) =>
          broadcast({
            t: 'gc',
            items: items.map(({ path, kilobytes, label, reason, ageDays }) => ({
              path,
              kilobytes,
              label,
              reason,
              ageDays,
            })),
          }),
        );
        break;
      case 'gcRemove':
        void (async () => {
          // re-check what's reclaimable, but skip du: the sizes came with the
          // scan, and du over a 60G checkout is most of the wait
          const safe = await findReclaimable(cfg, store.list(), store.listReviews(), store.listPlans(), 0, { sizes: false });
          const targets = safe.filter((i) => cmd.paths.includes(i.path));
          let failed = 0;
          for (const [index, item] of targets.entries()) {
            broadcast({ t: 'gcProgress', done: index, total: targets.length, path: item.path, ok: true, finished: false });
            const ok = await removeWorktree(item).then(
              () => true,
              (err) => {
                log(`gc: ${item.path}: ${err}`);
                failed++;
                return false;
              },
            );
            if (ok) {
              // the pointer died with the directory; don't leave a dead path
              for (const task of store.list()) {
                if (task.worktree === item.path) store.update(task.issue.id, { worktree: undefined });
              }
              for (const review of store.listReviews()) {
                if (review.worktree === item.path) store.updateReview(review.id, { worktree: undefined });
              }
            }
            broadcast({ t: 'gcProgress', done: index + 1, total: targets.length, path: item.path, ok, finished: false });
          }
          broadcast({ t: 'gcProgress', done: targets.length, total: targets.length, path: '', ok: !failed, finished: true });
          broadcast({
            t: 'toast',
            text: failed
              ? `removed ${targets.length - failed} of ${targets.length} — ${failed} failed, see the log`
              : `removed ${targets.length} worktrees`,
            kind: failed ? 'err' : 'ok',
          });
        })();
        break;
    }
  };

  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); // stale socket from a killed daemon
  writeFileSync(PID_PATH, String(process.pid));

  // a notification raised here also goes to connected clients, which is the
  // only way it reaches you when the daemon is on another machine
  onNotifyForward((n) => broadcast({ t: 'notify', ...n }));

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);
    socket.write(
      encode({ t: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, cfg, snapshot: store.snapshot() }),
    );
    const decode = createDecoder<ClientMsg>((msg) => {
      if (msg.t === 'cmd') run(msg.cmd, (out) => socket.write(encode(out)));
      else if (msg.t === 'sync') {
        const deltas = store.since(msg.version);
        if (deltas) for (const delta of deltas) socket.write(encode({ t: 'delta', delta }));
        else socket.write(encode({ t: 'snapshot', snapshot: store.snapshot() }));
      }
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      try {
        decode(chunk);
      } catch (err) {
        log(`daemon: bad message from client: ${err}`);
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clients.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, resolve);
  });
  log(`daemon listening on ${SOCKET_PATH} (pid ${process.pid})`);

  const shutdown = () => {
    log('daemon shutting down');
    dispatcher.shutdown();
    reviewer.shutdown();
    plans.shutdown();
    stopPrPolling();
    stopReviewPolling();
    setTimeout(() => {
      stopPersistence();
      server.close();
      if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
      process.exit(0);
    }, 200);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

/** Resolve a project id to the full project the PlanManager needs. */
async function withProject(projectId: string, run: (project: Project) => Promise<void>): Promise<void> {
  const cfg = loadConfig({ requireKey: false });
  const project = (await providerFor(cfg).projects().catch(() => [] as Project[])).find((p) => p.id === projectId);
  if (!project) {
    log(`startPlan: no project ${projectId}`);
    return;
  }
  await run(project);
}
