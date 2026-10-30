/**
 * The client never holds a tracker credential: the daemon sends its config
 * redacted, and every tracker call a view makes goes over the connection.
 *
 * This starts a real daemon — in demo mode, under a throwaway HOME, so it has
 * its own config, socket and state, runs no network and touches nothing of
 * yours — connects to it the way the TUI does, and talks to the tracker
 * through it.
 *
 * Run with `npx tsx src/core/thinclient.check.ts`. `bin/check` runs it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const home = realpathSync(mkdtempSync(join(tmpdir(), 'coli-thin-check-')));
// before anything of colinear's is imported: the state dir and the socket are
// decided at load time, and must be this HOME's, never the operator's
process.env.HOME = home;
process.env.COLINEAR_CONTEXT = 'demo';
delete process.env.COLINEAR_STATE_DIR;
delete process.env.COLINEAR_SOCKET;
delete process.env.LINEAR_API_KEY;

const SECRET = 'lin_api_must_never_reach_a_client';
let daemonPid: number | undefined;

try {
  const { contextConfigPath, stateDirFor } = await import('./context.js');
  const configFile = contextConfigPath('demo');
  mkdirSync(join(configFile, '..'), { recursive: true });
  mkdirSync(join(stateDirFor('demo'), 'cadence'), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      provider: 'sqlite',
      demo: true,
      // set on purpose: redaction has to blank a key that is really there
      linearApiKey: SECRET,
      repos: [{ name: 'cadence', path: join(stateDirFor('demo'), 'cadence'), defaultBranch: 'main' }],
    }),
  );

  const { connectToDaemon } = await import('../client.js');
  const { providerFor } = await import('./provider.js');
  const conn = await connectToDaemon();
  daemonPid = conn.daemonPid;

  check('the config a client gets has no key in it', conn.cfg.linearApiKey === '', conn.cfg.linearApiKey);
  check('and nothing else that looks like one', !JSON.stringify(conn.cfg).includes(SECRET));

  const provider = providerFor(conn.cfg);
  check('the provider a view gets is named for the real one', provider.name === 'sqlite', provider.name);
  check('with its capabilities, without asking', typeof provider.capabilities.subIssues === 'boolean');

  const scopes = await provider.scopes();
  check('a tracker read comes back through the daemon', Array.isArray(scopes) && scopes.length > 0, JSON.stringify(scopes));

  // the demo board is seeded into the tracker on start; give it a moment
  let issues: Awaited<ReturnType<typeof provider.issues>> = [];
  for (let i = 0; i < 50 && !issues.length; i++) {
    issues = await provider.issues('*', { includeProjects: true });
    if (!issues.length) await new Promise((r) => setTimeout(r, 100));
  }
  check('issues come back whole', issues.length > 0 && typeof issues[0].identifier === 'string', String(issues.length));
  check('branchFor answers without a round trip', provider.branchFor(issues[0]).length > 0);

  const created = await provider.create({ scopeId: scopes[0].id, title: 'filed through the daemon' });
  check('a tracker write goes through the daemon too', typeof created.identifier === 'string');
  const back = await provider.issuesByIds([created.id]);
  check('and is there when read back', back[0]?.title === 'filed through the daemon', JSON.stringify(back[0]));

  const missing = await provider.issuesByIds(['not-an-id']);
  check('a call that finds nothing answers with nothing', Array.isArray(missing) && missing.length === 0, JSON.stringify(missing));
  // a call the tracker throws on (here: no input at all) must come back as that error
  const error = await provider.create(undefined as never).then(
    () => 'ran',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
  check("a tracker's refusal reaches the view as an error with its message", error !== 'ran' && error.length > 0, error);

  // a name off the allowlist is refused, not looked up on the object — asked
  // over a raw connection, the way anything else on the socket could ask
  const { SOCKET_PATH } = await import('./protocol.js');
  const { connect } = await import('node:net');
  const answers = await new Promise<string[]>((resolve) => {
    const sock = connect(SOCKET_PATH);
    let buf = '';
    const got: string[] = [];
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      for (const [rid, method] of [[901, 'constructor'], [902, 'branchFor'], [903, '__proto__']] as const) {
        sock.write(`${JSON.stringify({ t: 'cmd', cmd: { name: 'provider', rid, method, args: [] } })}\n`);
      }
    });
    sock.on('data', (chunk: string) => {
      buf += chunk;
      for (const line of buf.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line) as { t: string; rid?: number; ok?: boolean; error?: string; cfg?: unknown };
        if (msg.t === 'hello') check('a raw connection is sent no key either', !JSON.stringify(msg.cfg).includes(SECRET));
        if (msg.t === 'providerResult') got.push(`${msg.rid}:${msg.ok ? 'ran' : msg.error}`);
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
      if (got.length === 3) {
        sock.destroy();
        resolve(got);
      }
    });
    setTimeout(() => {
      sock.destroy();
      resolve(got);
    }, 3_000);
  });
  check(
    'a name that is not a tracker call is refused',
    answers.length === 3 && answers.every((a) => a.includes('not a tracker call')),
    answers.join(' | '),
  );

  // documents the operator edits travel whole, so their paths never need to exist here
  check('a document that does not exist yet reads as nothing', (await conn.readDoc({ kind: 'plan', id: 'no-such-project' })) === undefined);
  conn.writeDoc({ kind: 'plan', id: 'thin-check' }, '# edited here\n');
  let roundTrip: string | undefined;
  for (let i = 0; i < 30 && roundTrip === undefined; i++) {
    roundTrip = await conn.readDoc({ kind: 'plan', id: 'thin-check' });
    if (roundTrip === undefined) await new Promise((r) => setTimeout(r, 50));
  }
  check('an edited document goes back and reads back', roundTrip === '# edited here\n', String(roundTrip));
  const toasts: string[] = [];
  const stopToasts = conn.onToast((text) => toasts.push(text));
  const withPr = (await import('./store.js')).store.list().find((t) => t.prs[0]);
  check('the demo board has a PR to promote', Boolean(withPr));
  if (withPr) {
    conn.dispatcher.promotePr(withPr.issue.id);
    for (let i = 0; i < 30 && !toasts.length; i++) await new Promise((r) => setTimeout(r, 50));
    check('promoting a demo PR reaches no GitHub, and says so', toasts.some((t) => t.includes('demo mode')), toasts.join(' | '));
  }
  stopToasts();

  // the connection going away must not leave a view waiting for ever
  const pending = provider.scopes();
  process.kill(daemonPid, 'SIGTERM');
  daemonPid = undefined;
  const docAfter = conn.readDoc({ kind: 'plan', id: 'thin-check' });
  const outcome = await Promise.race([
    pending.then(() => 'answered', (e: unknown) => `rejected: ${String(e)}`),
    new Promise<string>((r) => setTimeout(() => r('hung'), 5_000)),
  ]);
  check('a call in flight when the daemon goes is answered or rejected, never left hanging', outcome !== 'hung', outcome);
  const docOutcome = await Promise.race([docAfter.then(() => 'answered'), new Promise<string>((r) => setTimeout(() => r('hung'), 5_000))]);
  check('so is a document read', docOutcome === 'answered', docOutcome);
  conn.close();
} catch (err) {
  failures.push(`threw: ${String(err)}`);
} finally {
  if (daemonPid) {
    try {
      process.kill(daemonPid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(home, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`thin client: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a client gets no tracker credential, and its tracker calls are made by the daemon');
process.exit(0);
