import { SessionInbox, type AgentBackend } from '../agents/shared.js';
import { fromWire } from '../agents/tools.js';
import type { Config } from '../types.js';
import { localWorkspace, type Workspace } from '../workspace.js';
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
  info: { version: string; runtimes: string[] },
): void {
  let cfg: Config | undefined;
  // the worktree this runner serves, on this side: Workspace's local answer is
  // the runner's answer, including its refusal of paths that climb out
  let workspace: Workspace | undefined;
  const running = new Map<number, AbortController>();
  const watches = new Map<number, () => void>();
  const answer = (id: number, work: () => Promise<unknown>) => {
    void (async () => {
      if (!workspace) throw new Error('this runner serves no workspace');
      return work();
    })().then(
      (value) => link.send({ t: 'reply', id, ok: true, value: value ?? null }),
      (err: unknown) => link.send({ t: 'reply', id, ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
  };
  const sessions = new Map<
    string,
    { inbox?: SessionInbox; abort: AbortController; answers: Map<number, (answers: string[]) => void> }
  >();
  const toolCalls = new Map<number, (r: { ok: boolean; text: string }) => void>();
  let nextCall = 0;

  link.send({ t: 'hello', protocol: RUNNER_PROTOCOL, ...info });

  link.onFrame((frame) => {
    switch (frame.t) {
      case 'hello':
        if (frame.protocol !== RUNNER_PROTOCOL) {
          link.close();
          return;
        }
        cfg = frame.cfg;
        if (frame.workspace) workspace = localWorkspace(frame.workspace);
        break;
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
      case 'session.message':
        sessions.get(frame.sid)?.inbox?.push(frame.text);
        break;
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
    const abort = new AbortController();
    const answers = new Map<number, (answers: string[]) => void>();
    let nextQuestion = 0;
    // the daemon's inbox already stamped what it forwards; this one only relays
    const inbox = frame.opts.inbox
      ? new SessionInbox({ stamp: false, onDelivered: () => link.send({ t: 'session.delivered', sid }) })
      : undefined;
    sessions.set(sid, { inbox, abort, answers });
    const tools = fromWire(
      frame.tools,
      (name, input) =>
        new Promise((resolve, reject) => {
          const cid = ++nextCall;
          toolCalls.set(cid, (r) => (r.ok ? resolve(r.text) : reject(new Error(r.text))));
          link.send({ t: 'tool.call', sid, cid, name, input });
        }),
    );
    try {
      const result = await runtime(cfg, frame.runtime).runSession({
        ...frame.opts,
        inbox,
        abortController: abort,
        tools: tools.length ? tools : undefined,
        callbacks: {
          onActivity: (line) => link.send({ t: 'session.activity', sid, line }),
          onSessionId: (id) => link.send({ t: 'session.id', sid, id }),
          onUsage: (usage) => link.send({ t: 'session.usage', sid, usage }),
          onQuestion: (q) => {
            const qid = ++nextQuestion;
            answers.set(qid, q.answer);
            link.send({ t: 'session.question', sid, qid, kind: q.kind, questions: q.questions });
          },
        },
      });
      link.send({ t: 'session.result', sid, ok: true, result });
    } catch (err) {
      link.send({ t: 'session.result', sid, ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      inbox?.close();
      sessions.delete(sid);
    }
  }
}
