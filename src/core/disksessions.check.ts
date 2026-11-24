import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptTitle, scanDiskSessions } from './disksessions.js';

/**
 * :sessions reads two CLIs' private formats off disk, so what is pinned is
 * that both are found, described from their own head (the directory each
 * ran in, its first real prompt, whether a person or a program ran it), and
 * listed newest first — from a fabricated home, never the real one.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const home = mkdtempSync(join(tmpdir(), 'colinear-sessions-'));
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

const cdir = join(home, '.claude', 'projects', '-work-app');
mkdirSync(cdir, { recursive: true });
writeFileSync(join(cdir, 'aaaa-1.jsonl'),
  line({ type: 'mode', sessionId: 'aaaa-1' }) +
  line({ type: 'user', cwd: '/work/app', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
  line({ type: 'user', cwd: '/work/app', gitBranch: 'main', entrypoint: 'cli', message: { role: 'user', content: [{ type: 'text', text: 'Fix the  flaky\ntest' }] } }));
writeFileSync(join(cdir, 'bbbb-2.jsonl'),
  line({ type: 'user', cwd: '/work/app-worktrees/CLO-1', entrypoint: 'sdk-ts', message: { role: 'user', content: 'Work on CLO-1' } }));
writeFileSync(join(cdir, 'empty.jsonl'), line({ type: 'mode', sessionId: 'empty' }));

const xdir = join(home, '.codex', 'sessions', '2026', '11', '20');
mkdirSync(xdir, { recursive: true });
writeFileSync(join(xdir, 'rollout-x.jsonl'),
  line({ type: 'session_meta', payload: { id: 'cccc-3', cwd: '/work/other', originator: 'codex-tui', git: { branch: 'feat' } } }) +
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }) +
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the parser' }] } }));

const t = Date.now() / 1000;
utimesSync(join(cdir, 'aaaa-1.jsonl'), t - 300, t - 300);
utimesSync(join(cdir, 'bbbb-2.jsonl'), t - 200, t - 200);
utimesSync(join(xdir, 'rollout-x.jsonl'), t - 100, t - 100);

const list = scanDiskSessions(300, home);
check('both CLIs are found, and an empty transcript is not', list.length === 3, list.map((s) => s.id).join());
check('newest first', list.map((s) => s.id).join() === 'cccc-3,bbbb-2,aaaa-1', list.map((s) => s.id).join());
const claude = list.find((s) => s.id === 'aaaa-1');
check('a Claude session says where it ran and on what branch', claude?.cwd === '/work/app' && claude?.branch === 'main');
check('its title is the first real prompt, harness wrappers skipped', claude?.title === 'Fix the flaky test', claude?.title);
check('a person at the CLI is interactive', claude?.interactive === true);
check('an SDK session is a program', list.find((s) => s.id === 'bbbb-2')?.interactive === false);
const codex = list.find((s) => s.id === 'cccc-3');
check('a Codex session is described from its own metadata', codex?.runtime === 'codex' && codex?.cwd === '/work/other' && codex?.branch === 'feat' && codex?.title === 'Port the parser' && codex?.interactive === true);
check('a missing home lists nothing rather than failing', scanDiskSessions(300, join(home, 'nope')).length === 0);
check('a caveat is not a title', promptTitle('Caveat: the messages below') === undefined);

if (failures.length) {
  console.error(`sessions: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — Claude Code and Codex sessions are found, described from their own head, and listed\n     newest first, with a person told apart from a program');
