import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AgentBackend, RunSessionOpts, SessionResult } from '../agents/shared.js';
import { colinearTools, toWire } from '../agents/tools.js';
import { redactConfig } from '../config.js';
import { log } from '../log.js';
import type { Config } from '../types.js';
import { RUNNER_PROTOCOL, type FromRunner, type ToRunner } from './frames.js';
import { streamLink, type Link } from './link.js';

export type RunnerLink = Link<FromRunner, ToRunner>;

/**
 * A runtime whose sessions run in a runner rather than in this process.
 *
 * It answers every question about the runtime — capabilities, models, attach,
 * resume — from the real adapter, and only `runSession` goes elsewhere. What
 * can't cross a process boundary as data is turned into frames: callbacks,
 * questions and their answers, the operator's messages, cancellation, and
 * colinear's tools, whose handlers stay here (design/multi-user/runner.md,
 * "What can't cross as data").
 */
export function runnerBackend(inner: AgentBackend, open: () => Promise<RunnerLink>): AgentBackend {
  return { ...inner, runSession: (opts) => runRemote(inner.name, opts, open) };
}

async function runRemote(runtime: string, opts: RunSessionOpts, open: () => Promise<RunnerLink>): Promise<SessionResult> {
  const link = await open();
  const sid = randomUUID();
  const specs = opts.tools ?? colinearTools({ channels: opts.channels, coordinator: opts.coordinator });
  const handlers = new Map(specs.map((s) => [s.name, s.handler]));
  let done = false;

  try {
    return await new Promise<SessionResult>((resolve, reject) => {
      link.onFrame((frame) => {
        if (!('sid' in frame) || frame.sid !== sid) return;
        switch (frame.t) {
          case 'session.activity':
            opts.callbacks.onActivity(frame.line);
            break;
          case 'session.id':
            opts.callbacks.onSessionId(frame.id);
            break;
          case 'session.usage':
            opts.callbacks.onUsage?.(frame.usage);
            break;
          case 'session.question':
            opts.callbacks.onQuestion({
              kind: frame.kind,
              questions: frame.questions,
              answer: (answers) => link.send({ t: 'session.answer', sid, qid: frame.qid, answers }),
            });
            break;
          case 'session.delivered':
            opts.inbox?.markDelivered();
            break;
          case 'tool.call': {
            const handler = handlers.get(frame.name);
            const cid = frame.cid;
            void (handler ? handler(frame.input) : Promise.reject(new Error(`no tool named ${frame.name}`))).then(
              (text) => link.send({ t: 'tool.result', cid, ok: true, text }),
              (err: unknown) => link.send({ t: 'tool.result', cid, ok: false, text: String(err) }),
            );
            break;
          }
          case 'session.result':
            done = true;
            if (frame.ok) resolve(frame.result);
            else reject(new Error(frame.error));
            break;
        }
      });
      link.onClose((reason) => {
        if (!done) reject(new Error(`the runner went away before the session finished${reason ? `: ${reason}` : ''}`));
      });

      link.send({
        t: 'session.start',
        sid,
        runtime,
        opts: {
          prompt: opts.prompt,
          cwd: opts.cwd,
          outputSchema: opts.outputSchema,
          model: opts.model,
          fallbackModel: opts.fallbackModel,
          maxTurns: opts.maxTurns,
          resume: opts.resume,
          permissions: opts.permissions,
          agent: opts.agent ? { kind: opts.agent.kind, label: opts.agent.label, origin: opts.agent.origin } : undefined,
          inbox: Boolean(opts.inbox),
        },
        tools: toWire(specs),
      });

      const signal = opts.abortController?.signal;
      if (signal?.aborted) link.send({ t: 'session.abort', sid });
      else signal?.addEventListener('abort', () => link.send({ t: 'session.abort', sid }), { once: true });

      // the operator's messages: the daemon's inbox stamps and tracks them, the
      // runner's only relays. Its first yield is the prompt, already sent.
      if (opts.inbox) {
        const inbox = opts.inbox;
        void (async () => {
          let first = true;
          for await (const text of inbox.stream(opts.prompt)) {
            if (done) break;
            if (first) {
              first = false;
              continue;
            }
            link.send({ t: 'session.message', sid, text });
          }
        })();
      }
    });
  } finally {
    done = true;
    link.close();
  }
}

/** The script a runner child runs: this build's entry point, in runner mode. */
const entryScript = () =>
  fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../index.tsx' : '../../index.js', import.meta.url));

/**
 * A runner as a child process over stdio: `"runner": "process"`. One per
 * session for now; it exits when its session does. Resolves once the two
 * sides have agreed on a protocol.
 */
export function spawnRunner(cfg: Config): Promise<RunnerLink> {
  // execArgv carries the loader in dev (tsx), where the entry point is .tsx
  const child = spawn(process.execPath, [...process.execArgv, entryScript(), 'runner'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const link: RunnerLink = streamLink(child.stdout, child.stdin, () => child.kill());
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) log(`runner ${child.pid} exited ${code}`);
    if (signal && signal !== 'SIGTERM') log(`runner ${child.pid} killed by ${signal}`);
  });
  return handshake(link, cfg);
}

/** Wait for the runner's hello, check it speaks our protocol, and send ours. */
export function handshake(link: RunnerLink, cfg: Config, opts: { workspace?: string; timeoutMs?: number } = {}): Promise<RunnerLink> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      link.close();
      reject(new Error('the runner did not say hello'));
    }, timeoutMs);
    link.onClose((reason) => {
      clearTimeout(timer);
      reject(new Error(`the runner exited before it said hello${reason ? `: ${reason}` : ''}`));
    });
    link.onFrame((frame) => {
      if (frame.t !== 'hello') return;
      clearTimeout(timer);
      if (frame.protocol !== RUNNER_PROTOCOL) {
        link.close();
        reject(new Error(`the runner speaks protocol ${frame.protocol}, this daemon ${RUNNER_PROTOCOL}`));
        return;
      }
      // a runner never needs the tracker's key: it runs sessions, the daemon talks to the tracker
      link.send({ t: 'hello', protocol: RUNNER_PROTOCOL, cfg: redactConfig(cfg), ...(opts.workspace ? { workspace: opts.workspace } : {}) });
      resolve(link);
    });
  });
}
