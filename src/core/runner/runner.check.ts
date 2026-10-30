/**
 * A session run in a runner behaves like one run in-process: the caller gets
 * the same callbacks, answers questions the same way, reaches the agent with
 * the same inbox, and its tools' handlers still run here.
 *
 * The first half drives a scripted runtime through the real frame encoding
 * over in-memory pipes. The second starts a real `coli runner` child and
 * shakes hands with it. No agent CLI runs and nothing is spent.
 *
 * Run with `npx tsx src/core/runner/runner.check.ts`. `bin/check` runs it.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionInbox, type AgentBackend, type RunSessionOpts, type SessionResult } from '../agents/shared.js';
import { CLAUDE_CAPABILITIES } from '../agents/claude.js';
import type { CoordinatorTools } from '../coordinator.js';
import type { Config } from '../types.js';
import { handshake, pushCredentials, runnerBackend, spawnRunner, type RunnerLink } from './backend.js';
import { settableCredentials, type CredentialSource } from './credentials.js';
import type { FromRunner, ToRunner } from './frames.js';
import { serveRunner } from './host.js';
import { streamLink } from './link.js';
import { runnerWorkspace } from './workspace.js';
import { workspaceContract } from '../workspace.contract.js';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const SECRET = 'lin_api_never_for_a_runner';
const cfg = { linearApiKey: SECRET, repos: [] } as unknown as Config;

/** What a runner heard, so a check can ask afterwards. */
let runnerCfg: Config | undefined;

/** A runtime that exercises every frame and spends nothing. */
const scripted: AgentBackend = {
  name: 'scripted',
  capabilities: CLAUDE_CAPABILITIES,
  models: ['scripted-1'],
  claims: (m) => m.startsWith('scripted-'),
  cli: { command: 'scripted', versionArgs: [], install: '' },
  sessionExists: async () => false,
  transcriptDir: () => undefined,
  attachArgv: () => undefined,
  resumeHint: () => undefined,
  async runSession(opts: RunSessionOpts): Promise<SessionResult> {
    if (opts.prompt === 'wait for abort') {
      await new Promise<void>((resolve) => {
        if (opts.abortController?.signal.aborted) resolve();
        opts.abortController?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted by the operator');
    }
    if (opts.prompt === 'hang') await new Promise(() => {});
    opts.callbacks.onSessionId('conv-7');
    opts.callbacks.onActivity('reading the code');
    opts.callbacks.onUsage?.({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
    const answers = await new Promise<string[]>((answer) =>
      opts.callbacks.onQuestion({ kind: 'ask', questions: [{ text: 'which approach?', options: [] }], answer }),
    );
    const status = opts.tools?.find((t) => t.name === 'family_status');
    const told = status ? await status.handler({}) : 'no tool';
    let heard = '';
    if (opts.inbox) {
      for await (const text of opts.inbox.stream(opts.prompt)) {
        if (text === opts.prompt) continue;
        heard = text;
        opts.inbox.markDelivered();
        opts.inbox.close();
      }
    }
    return {
      text: [answers[0], told, heard, opts.model, opts.cwd].join('|'),
      costUsd: 0.5,
      isError: false,
      errors: [],
      assistantTurns: 3,
    };
  },
};

/** A runner in this process, on the other end of two pipes, speaking real frames. */
async function pipedRunner(workspace?: string, creds?: { dir: string; source: CredentialSource }): Promise<{ link: RunnerLink; kill: () => void }> {
  const toRunner = new PassThrough();
  const fromRunner = new PassThrough();
  const runnerSide = streamLink<ToRunner, FromRunner>(toRunner, fromRunner);
  runnerSide.onFrame((frame) => {
    if (frame.t === 'hello') runnerCfg = frame.cfg;
  });
  serveRunner(runnerSide, () => scripted, { version: 'check', runtimes: ['scripted'], credentialsDir: creds?.dir });
  const daemonSide = streamLink<FromRunner, ToRunner>(fromRunner, toRunner);
  return {
    link: await handshake(daemonSide, cfg, { workspace, credentials: creds?.source }),
    kill: () => {
      fromRunner.end();
      toRunner.end();
    },
  };
}

const run = async (): Promise<void> => {
  // ── one whole session through the runner ──────────────────────────────────
  const events: string[] = [];
  const coordinator: CoordinatorTools = {
    status: () => 'two of three merged',
    message: () => '',
    cancel: () => '',
    propose: () => '',
  };
  const inbox = new SessionInbox();
  let piped: Awaited<ReturnType<typeof pipedRunner>> | undefined;
  const backend = runnerBackend(scripted, async () => (piped = await pipedRunner()).link);
  const running = backend.runSession({
    prompt: 'fix the bug',
    cwd: '/w/ENG-7',
    model: 'scripted-1',
    inbox,
    coordinator,
    callbacks: {
      onSessionId: (id) => events.push(`id:${id}`),
      onActivity: (line) => events.push(`activity:${line}`),
      onUsage: (u) => events.push(`usage:${u.input}`),
      onQuestion: (q) => {
        events.push(`question:${q.questions[0]?.text}`);
        q.answer(['the small one']);
        // the agent is waiting on a turn; tell it something from the operator
        setTimeout(() => inbox.push('also update the docs'), 20);
      },
    },
  });
  const result = await running;
  check(
    'callbacks arrive in order',
    events.join(',') === 'id:conv-7,activity:reading the code,usage:10,question:which approach?',
    events.join(','),
  );
  const [answer, told, heard, model, cwd] = result.text.split('|');
  check('a question is answered across the pipe', answer === 'the small one', answer);
  check("a tool call runs the daemon's handler", told === 'two of three merged', told);
  check('an operator message reaches the agent, stamped once', heard === 'Message from the operator: also update the docs', heard);
  check('the model and cwd arrive as sent', model === 'scripted-1' && cwd === '/w/ENG-7', `${model} ${cwd}`);
  check('the result comes back whole', result.costUsd === 0.5 && result.assistantTurns === 3);
  check("delivery is relayed, so the daemon's inbox lets go", inbox.drain().length === 0);
  check('the runner was never sent the tracker key', runnerCfg !== undefined && !JSON.stringify(runnerCfg).includes(SECRET));

  // ── cancellation ───────────────────────────────────────────────────────────
  const controller = new AbortController();
  const aborting = backend.runSession({
    prompt: 'wait for abort',
    cwd: '/w',
    abortController: controller,
    callbacks: { onActivity: () => {}, onSessionId: () => {}, onQuestion: () => {} },
  });
  setTimeout(() => controller.abort(), 30);
  const aborted = await Promise.race([
    aborting.then(
      () => 'finished',
      (e: unknown) => String(e),
    ),
    new Promise<string>((r) => setTimeout(() => r('hung: the abort never reached the runner'), 3_000)),
  ]);
  check('cancelling here cancels there', aborted.includes('aborted by the operator'), aborted);

  // ── the runner dying mid-session ───────────────────────────────────────────
  const dying = backend.runSession({
    prompt: 'hang',
    cwd: '/w',
    callbacks: { onActivity: () => {}, onSessionId: () => {}, onQuestion: () => {} },
  });
  setTimeout(() => piped?.kill(), 50);
  const died = await Promise.race([
    dying.then(
      () => 'finished',
      (e: unknown) => String(e),
    ),
    new Promise<string>((r) => setTimeout(() => r('hung'), 3_000)),
  ]);
  check('a runner that goes away fails the session rather than hanging it', died.includes('went away'), died);

  // ── the workspace, served by a runner ─────────────────────────────────────
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coli-runner-ws-')));
  try {
    const served = await pipedRunner(root);
    const remote = runnerWorkspace(served.link, root);
    // the same contract a worktree on this disk meets, every line of it
    await workspaceContract('through a runner', remote, check);

    const none = await pipedRunner();
    const refused = await runnerWorkspace(none.link, root).readFile('x').then(
      () => 'served',
      (e: unknown) => String(e),
    );
    check('a runner with no workspace serves none', refused.includes('serves no workspace'), refused);
    none.kill();

    const slow = remote.exec(['sleep', '5']);
    const reading = remote.readFile('notes/a.md');
    served.kill();
    const lost = await Promise.race([slow, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
    check('a command in flight when the runner goes is a failed command, not a throw or a hang', lost !== null && lost.code === -1, JSON.stringify(lost));
    const unread = await reading.then(
      () => 'read',
      (e: unknown) => String(e),
    );
    check('a read in flight is rejected, saying why', unread === 'read' || unread.includes('went away'), unread);
    const after = await remote.exists('.').then(
      () => 'answered',
      (e: unknown) => String(e),
    );
    check('and so is one asked afterwards', after.includes('went away'), after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // ── credentials: pushed, written whole, renewed, and before any work ──────
  const credsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'coli-runner-creds-')));
  try {
    const dir = join(credsRoot, 'creds');
    const source = settableCredentials({ files: [{ path: 'claude/.credentials.json', content: '{"token":"one"}' }, { path: 'gh/hosts.yml', content: 'gh: one' }] });
    const withCreds = await pipedRunner(credsRoot, { dir, source });
    const file = join(dir, 'claude/.credentials.json');
    check('credentials are on disk before the link is handed over', readFileSync(file, 'utf8') === '{"token":"one"}');
    check('readable by the owner only', (statSync(file).mode & 0o077) === 0, (statSync(file).mode & 0o777).toString(8));

    source.set({ files: [{ path: 'claude/.credentials.json', content: '{"token":"two"}' }] });
    for (let i = 0; i < 40 && readFileSync(file, 'utf8') !== '{"token":"two"}'; i++) await new Promise((r) => setTimeout(r, 25));
    check('a renewal reaches a live runner', readFileSync(file, 'utf8') === '{"token":"two"}');
    check('and a file the new set leaves out is removed', !existsSync(join(dir, 'gh/hosts.yml')));

    await pushCredentials(withCreds.link, { version: 1, files: [{ path: 'claude/.credentials.json', content: '{"token":"stale"}' }] });
    check('an older set arriving late changes nothing', readFileSync(file, 'utf8') === '{"token":"two"}');

    const escaping = await pushCredentials(withCreds.link, { version: 99, files: [{ path: '../outside', content: 'x' }] }).then(
      () => 'written',
      (e: unknown) => String(e),
    );
    check('a credential path outside the directory is refused, and says so', escaping.includes('outside'), escaping);
    check('and nothing lands outside it', !existsSync(join(credsRoot, 'outside')));
    withCreds.kill();

    const empty = await pipedRunner(credsRoot, { dir, source: settableCredentials() }).then(
      () => 'handed over',
      (e: unknown) => String(e),
    );
    check('a runner is not handed work when there are no credentials to give it', empty.includes('no credentials'), empty);

    // the runner's own guard, for a daemon that skips the order
    const toRunner = new PassThrough();
    const fromRunner = new PassThrough();
    serveRunner(streamLink<ToRunner, FromRunner>(toRunner, fromRunner), () => scripted, { version: 'check', runtimes: ['scripted'], credentialsDir: dir });
    const raw = streamLink<FromRunner, ToRunner>(fromRunner, toRunner);
    const refusal = new Promise<string>((resolve) =>
      raw.onFrame((f) => {
        if (f.t === 'session.result' && !f.ok) resolve(f.error);
        if (f.t === 'reply' && !f.ok) resolve(f.error);
      }),
    );
    raw.send({ t: 'hello', protocol: 3, cfg, workspace: credsRoot, credentials: true });
    raw.send({ t: 'session.start', sid: 'early', runtime: 'scripted', opts: { prompt: 'x', cwd: credsRoot, inbox: false }, tools: [] });
    check('a runner refuses a session before its credentials', (await refusal).includes('before its credentials'));
    raw.close();
  } finally {
    rmSync(credsRoot, { recursive: true, force: true });
  }

  // ── a real child ───────────────────────────────────────────────────────────
  const child = await spawnRunner(cfg).then(
    (link) => link,
    (e: unknown) => String(e),
  );
  check('a real `coli runner` child says hello in our protocol', typeof child !== 'string', String(child));
  if (typeof child !== 'string') child.close();
};

await run();
if (failures.length) {
  console.error(`runner: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a session in a runner gets the same callbacks, questions, messages and tools, and\n     cancelling it or losing the runner ends it rather than hanging it');
process.exit(0);
