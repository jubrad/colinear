import { createServer, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './core/config.js';
import { Dispatcher } from './core/dispatcher.js';
import { STATE_DIR, log } from './core/log.js';
import { loadState, startPersistence } from './core/persist.js';
import { startPrPolling } from './core/prs.js';
import { Reviewer } from './core/reviewer.js';
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
import { store } from './core/store.js';

/** Liveness marker so `coli daemon status|stop` doesn't need the socket. */
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
  loadState(cfg);
  reviewer.resumeWatching(); // reviews restored from disk keep their live doc
  const stopPersistence = startPersistence();
  const stopPrPolling = startPrPolling(cfg, dispatcher);
  const stopReviewPolling = startReviewPolling(cfg, async () => {
    // a poll is what discovers a PR is merged or taken, so cleanup follows it
    await reviewer.cleanupStale();
  });

  const clients = new Set<Socket>();
  const broadcast = (msg: ServerMsg) => {
    const line = encode(msg);
    for (const socket of clients) socket.write(line);
  };

  dispatcher.onToast = (text, kind) => broadcast({ t: 'toast', text, kind });
  reviewer.onToast = (text, kind) => broadcast({ t: 'toast', text, kind });

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

  const run = (cmd: Command) => {
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
        pending?.answer(cmd.text);
        break;
      }
      case 'applyEdits':
        void dispatcher.applyEdits(cmd.id, cmd.edits);
        break;
      case 'pollPrs':
        void dispatcher.pollPrs();
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
        void pollReviewRequests(cfg);
        break;
      case 'channelPost':
        dispatcher.channelPost(cmd.channel, cmd.text);
        break;
      case 'gcScan':
        void findReclaimable(cfg, store.list(), store.listReviews(), cmd.olderThanDays).then((items) =>
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
          const safe = await findReclaimable(cfg, store.list(), store.listReviews(), 0, { sizes: false });
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

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setNoDelay(true);
    socket.write(
      encode({ t: 'hello', protocol: PROTOCOL_VERSION, pid: process.pid, cfg, snapshot: store.snapshot() }),
    );
    const decode = createDecoder<ClientMsg>((msg) => {
      if (msg.t === 'cmd') run(msg.cmd);
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
