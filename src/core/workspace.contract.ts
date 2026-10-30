/**
 * The behaviour every Workspace must have, whatever is behind it: the same
 * script runs against a worktree on this disk and against one a runner
 * serves, and both must answer alike (design/multi-user/runner.md).
 *
 * `ws` must be a scratch directory: the script writes `notes/` into it.
 */
import { join } from 'node:path';
import type { Workspace } from './workspace.js';

export async function workspaceContract(label: string, ws: Workspace, check: (name: string, ok: boolean, detail?: string) => void) {
  const ok = await ws.exec(['sh', '-c', 'echo out; echo err >&2']);
  check(`${label}: a command that works says 0`, ok.code === 0, JSON.stringify(ok));
  check(`${label}: and keeps each stream`, ok.stdout === 'out\n' && ok.stderr === 'err\n');
  check(`${label}: and both, interleaved`, ok.output.includes('out') && ok.output.includes('err'));
  const bad = await ws.exec(['sh', '-c', 'exit 3']);
  check(`${label}: a command that fails says its code, without throwing`, bad.code === 3);
  const missing = await ws.exec(['no-such-command-coli']);
  check(`${label}: a command that cannot start says -1`, missing.code === -1 && missing.output.length > 0, JSON.stringify(missing));
  const input = await ws.exec(['cat'], { input: 'piped in' });
  check(`${label}: input reaches the command`, input.stdout === 'piped in');
  const env = await ws.exec(['sh', '-c', 'echo $COLI_CHECK'], { env: { COLI_CHECK: 'set' } });
  check(`${label}: env reaches the command`, env.stdout.trim() === 'set');
  const big = await ws.exec(['sh', '-c', 'yes x | head -c 5000'], { maxOutput: 1000 });
  check(`${label}: output is capped to its tail, and says so`, big.stdout.length === 1000 && big.truncated);
  const slow = await ws.exec(['sleep', '5'], { timeoutMs: 200 });
  check(`${label}: a timeout stops the command`, slow.code !== 0);
  const abort = new AbortController();
  const stopping = ws.exec(['sleep', '5'], { signal: abort.signal });
  abort.abort();
  check(`${label}: an abort stops the command`, (await stopping).code !== 0);

  await ws.writeFile('notes/a.md', 'first');
  check(`${label}: a written file reads back`, (await ws.readFile('notes/a.md')) === 'first');
  await ws.writeFile('notes/a.md', 'second');
  check(`${label}: and is replaced whole`, (await ws.readFile('notes/a.md')) === 'second');
  check(`${label}: exists says so`, (await ws.exists('notes/a.md')) && !(await ws.exists('notes/b.md')));
  check(`${label}: a missing file reads as undefined`, (await ws.readFile('notes/b.md')) === undefined);
  let changes = 0;
  const stopWatching = ws.watch('notes/watched.md', () => changes++);
  await ws.writeFile('notes/watched.md', 'appeared');
  for (let i = 0; i < 20 && !changes; i++) await new Promise((r) => setTimeout(r, 50));
  stopWatching();
  check(`${label}: a watched file reports a change, including its first appearance`, changes > 0);
  const sub = await ws.exec(['pwd'], { cwd: 'notes' });
  check(`${label}: cwd is relative to the worktree`, sub.stdout.trim() === join(ws.path, 'notes'), sub.stdout);

  // nothing outside the worktree, by any route
  const escapes: Array<[string, () => Promise<unknown>]> = [
    ['read ../', () => ws.readFile('../outside.txt')],
    ['read an absolute path', () => ws.readFile('/etc/hosts')],
    ['write ../', () => ws.writeFile('../outside.txt', 'x')],
    ['exists ../', () => ws.exists('../outside.txt')],
  ];
  for (const [what, attempt] of escapes) {
    const refused = await attempt().then(
      () => false,
      (e: unknown) => String(e).includes('outside the worktree'),
    );
    check(`${label}: refuses to ${what}`, refused);
  }
  const climbing = await ws.exec(['pwd'], { cwd: '..' });
  check(`${label}: refuses a cwd outside it`, climbing.code === -1 && climbing.output.includes('outside the worktree'), JSON.stringify(climbing));
}
