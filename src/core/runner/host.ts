import { SessionInbox, type AgentBackend, type RunSessionOpts, type SessionResult } from '../agents/shared.js';
import { fromWire } from '../agents/tools.js';
import type { Config } from '../types.js';
import { localWorkspace, type Workspace } from '../workspace.js';
import { writeCredentials, type CredentialSet } from './credentials.js';
import { RUNNER_PROTOCOL, type FromRunner, type ToRunner } from './frames.js';
import type { Link } from './link.js';

/**
 * The runner's side: run the sessions a daemon sends, next to the worktree,
 * and report everything back as frames.
 *
 * The runtime adapters are the same ones the daemon uses in-process; what
 * changes is only who is listening. Tool handlers never come here — the tools
 * arrive as specs and every call goes back to the daemon, so a runner cannot
 * widen what a session may do (design/multi-user/runner.md).
 */
export function serveRunner(
  link: Link<ToRunner, FromRunner>,
  /** the runtime adapter by name, without the daemon's registry around it */
  runtime: (cfg: Config, name: string) => AgentBackend,
  info: {
    version: string;
    runtimes: string[];
    credentialsDir?: string;
    /** how long a turn the renewal window broke waits for the new set; checks shorten it */
    renewalWaitMs?: number;
  },
): void {
  const { credentialsDir, renewalWaitMs = RENEWAL_WAIT_MS, ...hello } = info;
  // when a set last replaced another: a renewal, which revokes the token the old one held
  let renewedAt = 0;
  const renewalWaiters = new Set<() => void>();
  // set by hello: work waits until a credential set is on disk
  let needsCredentials = false;
  let held: CredentialSet | undefined;
  const ready = () => !needsCredentials || held !== undefined;
  let cfg: Config | undefined;
  // the worktree this runner serves, on this side: Workspace's local answer is
  // the runner's answer, including its refusal of paths that climb out
  let workspace: Workspace | undefined;
  const running = new Map<number, AbortController>();
  const watches = new Map<number, () => void>();
  const answer = (id: number, work: () => Promise<unknown>) => {
    void (async () => {
      if (!workspace) throw new Error('this runner serves no workspace');
      if (!ready()) throw new Error('no credentials yet');
      return work();
    })().then(
      (value) => link.send({ t: 'reply', id, ok: true, value: value ?? null }),
      (err: unknown) => link.send({ t: 'reply', id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const sessions = new Map<
    string,
    {
      inbox?: SessionInbox;
      abort: AbortController;
      answers: Map<number, (answers: string[]) => void>;
      heard: (text: string) => void;
    }
  >();
  const toolCalls = new Map<number, (r: { ok: boolean; text: string }) => void>();
  let nextCall = 0;

  link.send({ t: 'hello', protocol: RUNNER_PROTOCOL, ...hello });

  link.onFrame((frame) => {
    switch (frame.t) {
      case 'hello':
        if (frame.protocol !== RUNNER_PROTOCOL) {
          link.close();
          return;
        }
        cfg = frame.cfg;
        if (frame.workspace) workspace = localWorkspace(frame.workspace);
        needsCredentials = Boolean(frame.credentials);
        break;
      case 'credentials': {
        const { set } = frame;
        // newer is all that matters; a late, older push is not a reason to go back
        if (held && set.version <= held.version) {
          link.send({ t: 'credentials.ack', version: set.version, ok: true });
          break;
        }
        try {
          if (!credentialsDir) throw new Error('this runner has nowhere to put credentials');
          writeCredentials(credentialsDir, set, held);
          if (held) {
            renewedAt = Date.now();
            for (const wake of renewalWaiters) wake();
          }
          held = set;
          link.send({ t: 'credentials.ack', version: set.version, ok: true });
        } catch (err) {
          link.send({ t: 'credentials.ack', version: set.version, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      }
      case 'exec': {
        const controller = new AbortController();
        running.set(frame.id, controller);
        answer(frame.id, () => workspace!.exec(frame.argv, { ...frame.opts, signal: controller.signal }).finally(() => running.delete(frame.id)));
        break;
      }
      case 'exec.cancel':
        running.get(frame.id)?.abort();
        break;
      case 'fs.read':
        answer(frame.id, () => workspace!.readFile(frame.path));
        break;
      case 'fs.write':
        answer(frame.id, () => workspace!.writeFile(frame.path, frame.content));
        break;
      case 'fs.exists':
        answer(frame.id, () => workspace!.exists(frame.path));
        break;
      case 'watch':
        try {
          if (!workspace) throw new Error('this runner serves no workspace');
          const id = frame.id;
          watches.set(id, workspace.watch(frame.path, () => link.send({ t: 'watch.changed', id })));
          link.send({ t: 'reply', id, ok: true, value: null });
        } catch (err) {
          link.send({ t: 'reply', id: frame.id, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
        break;
      case 'unwatch':
        watches.get(frame.id)?.();
        watches.delete(frame.id);
        break;
      case 'session.start':
        void start(frame);
        break;
      case 'session.message': {
        const s = sessions.get(frame.sid);
        s?.heard(frame.text);
        s?.inbox?.push(frame.text);
        break;
      }
      case 'session.answer': {
        const s = sessions.get(frame.sid);
        s?.answers.get(frame.qid)?.(frame.answers);
        s?.answers.delete(frame.qid);
        break;
      }
      case 'session.abort':
        sessions.get(frame.sid)?.abort.abort();
        break;
      case 'tool.result':
        toolCalls.get(frame.cid)?.({ ok: frame.ok, text: frame.text });
        toolCalls.delete(frame.cid);
        break;
    }
  });

  // the daemon is gone: nothing will answer a question or take a result, so stop
  link.onClose(() => {
    for (const s of sessions.values()) s.abort.abort();
    for (const c of running.values()) c.abort();
    for (const stop of watches.values()) stop();
  });

  async function start(frame: Extract<ToRunner, { t: 'session.start' }>) {
    const { sid } = frame;
    if (!cfg) {
      link.send({ t: 'session.result', sid, ok: false, error: 'session started before hello' });
      return;
    }
    if (!ready()) {
      link.send({ t: 'session.result', sid, ok: false, error: 'session started before its credentials arrived' });
      return;
    }
    const abort = new AbortController();
    const answers = new Map<number, (answers: string[]) => void>();
    let nextQuestion = 0;
    // What the turn that just ended was answering, so a turn the renewal window
    // broke can be sent again: the opening prompt until a turn completes, then
    // the operator's messages that arrived after it.
    let turns = 0;
    let sinceLastTurn: string[] = [];
    let lastTurnInput: string[] = [];
    // the daemon's inbox already stamped what it forwards; this one only relays
    const newInbox = () =>
      frame.opts.inbox
        ? new SessionInbox({
            stamp: false,
            onDelivered: () => {
              turns++;
              lastTurnInput = sinceLastTurn;
              sinceLastTurn = [];
              link.send({ t: 'session.delivered', sid });
            },
          })
        : undefined;
    const session = { inbox: newInbox(), abort, answers, heard: (text: string) => sinceLastTurn.push(text) };
    sessions.set(sid, session);
    const tools = fromWire(
      frame.tools,
      (name, input) =>
        new Promise((resolve, reject) => {
          const cid = ++nextCall;
          toolCalls.set(cid, (r) => (r.ok ? resolve(r.text) : reject(new Error(r.text))));
          link.send({ t: 'tool.call', sid, cid, name, input });
        }),
    );
    let conversation: string | undefined;
    const backend = runtime(cfg, frame.runtime);
    const run = (opts: Pick<RunSessionOpts, 'prompt' | 'resume'>) =>
      outcome(
        backend.runSession({
          ...frame.opts,
          ...opts,
          inbox: session.inbox,
          abortController: abort,
          tools: tools.length ? tools : undefined,
          callbacks: {
            onActivity: (line) => link.send({ t: 'session.activity', sid, line }),
            onSessionId: (id) => {
              conversation = id;
              link.send({ t: 'session.id', sid, id });
            },
            onUsage: (usage) => link.send({ t: 'session.usage', sid, usage }),
            onQuestion: (q) => {
              const qid = ++nextQuestion;
              answers.set(qid, q.answer);
              link.send({ t: 'session.question', sid, qid, kind: q.kind, questions: q.questions });
            },
          },
        }),
      );
    try {
      let ended = await run({ prompt: frame.opts.prompt });
      // The renewal window (design/multi-user/credentials.md): renewing revokes
      // the token this pod holds until the new set lands, and a turn in between
      // fails. If a new set landed around the failure, send that turn again,
      // resuming the conversation. Once: a second failure is a real one.
      if (!abort.signal.aborted && revokedTurn(ended) && (await renewedAround(Date.now()))) {
        // the adapter counts a turn that ended, even in failure, as delivered;
        // one that threw never got that far
        const counted = Boolean(frame.opts.inbox) && 'result' in ended;
        const before = counted ? turns - 1 : turns;
        const failing = counted ? lastTurnInput : sinceLastTurn;
        const input = [...(before <= 0 ? [frame.opts.prompt] : []), ...failing].join('\n\n');
        const resume = conversation ?? frame.opts.resume;
        if (resume || before <= 0) {
          link.send({ t: 'session.activity', sid, line: 'its token was renewed mid-turn — sending the turn again' });
          session.inbox?.close();
          session.inbox = newInbox();
          ended = await run({ prompt: input, resume });
        }
      }
      if ('result' in ended) link.send({ t: 'session.result', sid, ok: true, result: ended.result });
      else link.send({ t: 'session.result', sid, ok: false, error: ended.error });
    } finally {
      session.inbox?.close();
      sessions.delete(sid);
    }
  }

  /** Whether a set replaced another shortly before `failedAt`, or does within the wait. */
  function renewedAround(failedAt: number): Promise<boolean> {
    if (renewedAt && failedAt - renewedAt <= RENEWAL_LOOKBACK_MS) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (renewed: boolean) => {
        clearTimeout(timer);
        renewalWaiters.delete(wake);
        resolve(renewed);
      };
      const wake = () => done(true);
      const timer = setTimeout(() => done(false), renewalWaitMs);
      renewalWaiters.add(wake);
    });
  }
}

/** How long a broken turn waits for its new credentials, and how recent a renewal still counts. */
const RENEWAL_WAIT_MS = 10_000;
const RENEWAL_LOOKBACK_MS = 30_000;

type Ended = { result: SessionResult } | { error: string };

function outcome(p: Promise<SessionResult>): Promise<Ended> {
  return p.then(
    (result) => ({ result }),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  );
}

/**
 * A turn that failed because its token was revoked. Claude's CLI ends the turn
 * with "Failed to authenticate: OAuth token revoked" (spike 0.1); an error is
 * matched anywhere in it, but a result's text only at its start, since an
 * agent working on authentication code can say the words in an answer.
 */
export function revokedTurn(ended: Ended): boolean {
  if ('error' in ended) return REVOKED.test(ended.error);
  const { result } = ended;
  return result.errors.some((e) => REVOKED.test(e)) || /^\s*(Failed to authenticate|API Error: 401)/.test(result.text);
}

const REVOKED = /OAuth token revoked|Failed to authenticate|API Error: 401/i;
