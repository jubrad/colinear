#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { App, VERSION } from './app.js';
import { connectToDaemon } from './client.js';
import { consumePendingAction } from './core/attach.js';
import { parseAnswerDoc } from './core/answers.js';
import { runInit } from './core/init.js';
import { configPath, ensureConfigFile, loadConfig } from './core/config.js';
import { providerFor } from './core/provider.js';
import type { Config } from './core/types.js';
import {
  CONTEXT,
  CONTEXTS_DIR,
  DEFAULT_CONTEXT,
  contextConfigPath,
  listContexts,
  stateDirFor,
} from './core/context.js';
import { runDaemon, PID_PATH } from './daemon.js';
import {
  createBackup,
  defaultBackupName,
  formatBytes,
  readManifest,
  restoreBackup,
} from './core/backup.js';
import { findReclaimable, findSettled, formatSize, removeWorktree } from './core/gc.js';
import { loadState } from './core/persist.js';
import { log } from './core/log.js';
import { SOCKET_PATH } from './core/protocol.js';
import { store } from './core/store.js';

/** exit code the TUI uses to ask the supervisor for a fresh process */
const RELOAD_EXIT = 75;

// Synchronized output (DEC 2026): wrap every frame Ink writes so supporting
// terminals (iTerm2, Ghostty, Kitty, WezTerm) paint it atomically instead of
// showing the erase-then-rewrite as a flash. Terminals without it ignore the
// guards. Only active while the TUI owns the screen.
const realWrite = process.stdout.write.bind(process.stdout);
const syncWrite = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
  typeof chunk === 'string'
    ? (realWrite as (...args: unknown[]) => boolean)(`\x1b[?2026h${chunk}\x1b[?2026l`, ...rest)
    : (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;

// stderr leaking from the SDK / libraries lands outside Ink's synchronized
// frames and tears the screen — divert it to the debug log while the TUI is up
const realErrWrite = process.stderr.write.bind(process.stderr);
const logErrWrite = ((chunk: string | Uint8Array) => {
  log(`stderr: ${String(chunk).trimEnd()}`);
  return true;
}) as typeof process.stderr.write;

const enterAltScreen = () => {
  realWrite('\x1b[?1049h\x1b[H');
  process.stdout.write = syncWrite;
  process.stderr.write = logErrWrite;
};
const leaveAltScreen = () => {
  process.stdout.write = realWrite;
  process.stderr.write = realErrWrite;
  realWrite('\x1b[?1049l');
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open a file in the operator's editor and wait for it to close. The config's
 * `editor` wins over $EDITOR (the precedence git gives core.editor), and may
 * carry flags — "code --wait" — so it runs through the shell with the path as
 * a positional argument rather than being split by hand.
 */
function openEditor(cfg: Config, path: string): void {
  const editor = cfg.editor ?? process.env.EDITOR ?? 'vi';
  spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', path], { stdio: 'inherit' });
}

/** Single-quote for a remote shell: the only escape inside '' is '\''. */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** " on vm" — so a handoff never leaves you guessing which machine you're on. */
const where = (cfg: Config): string => (cfg.remote ? ` on ${cfg.remote.label}` : '');

/**
 * Run one shell command wherever the daemon lives. The prefix decides how —
 * ssh, docker exec, kubectl exec — and each of them takes the command as a
 * single argument, so colinear doesn't need to know which one it is.
 */
function runThere(remote: { exec: string[]; label: string }, command: string): void {
  const [bin, ...args] = remote.exec;
  spawnSync(bin, [...args, command], { stdio: 'inherit' });
}

function daemonPid(pidPath = PID_PATH): number | undefined {
  if (!existsSync(pidPath)) return undefined;
  const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
  if (Number.isNaN(pid)) return undefined;
  try {
    process.kill(pid, 0); // signal 0 just tests liveness
    return pid;
  } catch {
    return undefined; // pidfile outlived the process
  }
}

/** `coli daemon [stop|status|socket]` — the backend, and its lifecycle controls. */
async function daemonCommand(sub?: string): Promise<void> {
  // A remote or containerized daemon's pidfile holds a pid from ITS namespace.
  // Signalling that number here would, at best, do nothing — at worst it would
  // kill an unrelated local process that happens to share the id.
  const remote = loadConfig({ requireKey: false }).remote;
  if (remote && sub !== undefined && sub !== 'socket') {
    console.log(
      `this context's daemon runs on ${remote.label} — manage it there:\n` +
        `  ${remote.exec.join(' ')} ${sub === 'stop' ? "'pkill -f \"coli daemon\"'" : "'coli daemon status'"}`,
    );
    return;
  }
  const pid = daemonPid();
  if (sub === 'stop') {
    if (!pid) {
      console.log('no daemon running');
      if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      return;
    }
    process.kill(pid, 'SIGTERM');
    console.log(`stopped daemon (pid ${pid}) — agents were aborted and resume with r`);
    return;
  }
  // asked over ssh by the far side's tunnel setup: where this context's socket
  // is depends on HOME and the context, so the answer has to come from here
  if (sub === 'socket') {
    console.log(SOCKET_PATH);
    return;
  }
  if (sub === 'status') {
    // name the context: "no daemon running" is confusing when the reason is
    // that you're pointed at a different one than the daemon you started
    const where = CONTEXT === DEFAULT_CONTEXT ? '' : ` [context ${CONTEXT}]`;
    console.log(pid ? `daemon running (pid ${pid}) on ${SOCKET_PATH}${where}` : `no daemon running${where}`);
    return;
  }
  if (pid) {
    console.error(`a daemon is already running (pid ${pid})`);
    process.exit(1);
  }
  await runDaemon();
}

/**
 * `coli demo` — colinear with nothing behind it.
 *
 * Writes a `demo` context (local sqlite tracker, demo mode on) if it doesn't
 * exist and launches into it. Nothing is dispatched for real, nothing is
 * billed, and no PR or review is ever fetched or posted.
 */
function demoCommand(): never {
  const path = contextConfigPath('demo');
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          provider: 'sqlite',
          demo: true,
          concurrency: 3,
          // a repo that is never touched: demo mode runs no git at all
          repos: [{ name: 'cadence', path: join(stateDirFor('demo'), 'cadence'), defaultBranch: 'main' }],
        },
        null,
        2,
      )}\n`,
    );
    mkdirSync(join(stateDirFor('demo'), 'cadence'), { recursive: true });
    console.log(`wrote ${path}`);
  }
  console.log('starting colinear in demo mode — fabricated board, scripted agents, no network\n');
  // re-exec as the supervisor, in that context
  const script = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [...process.execArgv, script], {
    stdio: 'inherit',
    env: { ...process.env, COLINEAR_CONTEXT: 'demo' },
  });
  process.exit(result.status ?? 0);
}

/**
 * `coli issue add "title"` — file an issue from the shell.
 *
 * Mostly for the sqlite tracker, which otherwise has no way in that doesn't
 * cost an agent call, but it works against any provider.
 */
async function issueCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub !== 'add') {
    console.error('usage: coli issue add "title" [--desc TEXT] [--parent KEY] [--priority 0-4] [--scope KEY]');
    process.exit(1);
  }
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  const title = rest.find((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true);
  if (!title) {
    console.error('a title is required: coli issue add "fix the thing"');
    process.exit(1);
  }
  const cfg = loadConfig();
  const provider = providerFor(cfg);
  const scopes = await provider.scopes();
  const wanted = flag('scope') ?? cfg.team;
  const scope = scopes.find((s) => s.key === wanted) ?? scopes[0];
  if (!scope) {
    console.error(`${provider.name} has no ${provider.scopeLabel} to file into`);
    process.exit(1);
  }
  const parentKey = flag('parent');
  let parentId: string | undefined;
  if (parentKey) {
    const all = await provider.issues('*', { includeProjects: true });
    const parent = all.find((i) => i.identifier.toLowerCase() === parentKey.toLowerCase());
    if (!parent) {
      console.error(`no open issue called ${parentKey}`);
      process.exit(1);
    }
    parentId = parent.id;
  }
  const created = await provider.create({
    scopeId: scope.id,
    title,
    description: flag('desc'),
    priority: flag('priority') ? Number.parseInt(flag('priority')!, 10) : undefined,
    parentId,
  });
  console.log(`${created.identifier}  ${title}${parentKey ? ` (sub-issue of ${parentKey})` : ''}`);
}

/**
 * `coli contexts` — which configs exist, where each one's state lives, and
 * whether it has a daemon up. Contexts are independent: one daemon, one store
 * and one socket each, so two can run side by side.
 */
function contextsCommand(): void {
  for (const name of listContexts()) {
    const dir = stateDirFor(name);
    const pid = daemonPid(join(dir, 'coli.pid'));
    const mark = name === CONTEXT ? '*' : ' ';
    console.log(
      `${mark} ${name.padEnd(14)} ${(pid ? `daemon ${pid}` : 'stopped').padEnd(12)} ${contextConfigPath(name)}`,
    );
  }
  if (CONTEXT !== DEFAULT_CONTEXT) console.log(`\nstate: ${stateDirFor(CONTEXT)}`);
  console.log(
    `\nadd one by writing ${join(CONTEXTS_DIR, '<name>.json')} — it layers over the default config.` +
      `\nselect with: coli --context <name>  (or COLINEAR_CONTEXT=<name>)`,
  );
}

/**
 * `coli gc [--yes] [--older-than N]` — reclaim worktree disk. Prints what it
 * would remove and stops there unless told otherwise: a worktree is cheap to
 * recreate but the printout is the only chance to notice one you still want.
 */
async function gcCommand(args: string[]): Promise<void> {
  const cfg = loadConfig({ requireKey: false });
  const yes = args.includes('--yes') || args.includes('-y');
  const idx = args.findIndex((a) => a === '--older-than');
  const olderThanDays =
    idx !== -1 ? Number.parseFloat(args[idx + 1] ?? String(cfg.worktreeRetentionDays)) : cfg.worktreeRetentionDays;

  // read the daemon's state file rather than talking to it: gc is a disk
  // chore, and it should work whether or not colinear is running
  loadState(cfg);
  const tasks = store.list();
  if (!tasks.length) {
    console.log(
      'no tasks in state — every worktree would look orphaned, so only stale review\n' +
        'checkouts are considered. Is COLINEAR_STATE_DIR pointing somewhere unexpected?',
    );
  }
  const items = await findReclaimable(cfg, tasks, store.listReviews(), store.listPlans(), olderThanDays);
  // Cards are listed but never forgotten from here: this command edits no
  // state, and a running daemon owns state.json — writing it behind the
  // daemon's back loses whichever copy saves second. `:gc` does it live.
  const cards = findSettled(tasks, store.listReviews(), olderThanDays);
  if (!items.length && !cards.length) {
    console.log('nothing to reclaim');
    return;
  }

  let total = 0;
  for (const item of items) {
    total += item.kilobytes;
    console.log(
      `${formatSize(item.kilobytes).padStart(7)}  ${item.label.padEnd(12)} ${item.reason.padEnd(9)} ${Math.floor(item.ageDays)}d  ${item.path}`,
    );
  }
  console.log(`\n${items.length} worktrees · ${formatSize(total)}`);
  if (cards.length) {
    console.log(
      `\n${cards.length} finished card${cards.length === 1 ? '' : 's'} on the board ` +
        `(${cards.slice(0, 6).map((c) => c.label).join(', ')}${cards.length > 6 ? ', …' : ''})` +
        `\nforget them in \`:gc\` — this command doesn't edit board state`,
    );
  }

  if (!items.length) return;

  if (!yes) {
    console.log(`\nnothing removed. re-run with --yes to reclaim it` +
      ` (finished tasks newer than ${olderThanDays}d are kept; --older-than N to change)`);
    return;
  }
  for (const item of items) {
    process.stdout.write(`removing ${item.path} … `);
    await removeWorktree(item);
    console.log('done');
  }
  console.log(`\nreclaimed ${formatSize(total)}`);
}

/**
 * The TUI: a client of the daemon. Everything stateful lives over there, so
 * quitting, reloading, or crashing this process leaves the agents alone.
 */
async function runTui(): Promise<void> {
  const conn = await connectToDaemon();
  const cfg = conn.cfg;
  let reload = false;

  // The TUI runs in a loop so `s` (attach) can hand this terminal to an
  // interactive `claude --resume` and drop back onto the board afterwards.
  for (;;) {
    enterAltScreen();
    const app = render(
      <App
        cfg={cfg}
        dispatcher={conn.dispatcher}
        onToast={conn.onToast}
        onGc={conn.onGc}
        onGcProgress={conn.onGcProgress}
        onPlanChatReady={conn.onPlanChatReady}
        onAgents={conn.onAgents}
        onReviewDiff={conn.onReviewDiff}
        onTaskDiff={conn.onTaskDiff}
        onCreating={conn.onCreating}
        onLogTail={conn.onLogTail}
        onChannels={conn.onChannels}
        onChannelHistory={conn.onChannelHistory}
        onNotify={conn.onNotify}
      />,
      { patchConsole: true },
    );
    await app.waitUntilExit();
    leaveAltScreen();

    const action = consumePendingAction();
    if (!action) break;
    if (action.kind === 'reload-ui') {
      reload = true;
      break;
    }
    if (action.kind === 'attach' && action.mode === 'shell') {
      console.log(`shell in ${action.worktree}${where(cfg)} — exit to return to colinear\n`);
      if (cfg.remote) {
        // the worktree is on the daemon's machine. Spawning a local shell here
        // would either fail silently or — worse, when both machines use the
        // same layout — drop you in a same-named directory on the wrong host.
        runThere(cfg.remote, `cd ${shq(action.worktree)} && exec $SHELL -l`);
      } else {
        spawnSync(process.env.SHELL ?? 'zsh', [], { cwd: action.worktree, stdio: 'inherit' });
      }
    } else if (action.kind === 'attach') {
      if (action.waitMs) {
        console.log(`suspending ${action.identifier}'s agent…`);
        await sleep(action.waitMs);
      }
      console.log(`attaching to ${action.identifier}${where(cfg)} — quit claude (/exit) to return to colinear\n`);
      if (cfg.remote) {
        // the transcript lives in ~/.claude/projects/<encoded-cwd> on the
        // daemon's host, so resuming has to happen there too
        runThere(
          cfg.remote,
          `cd ${shq(action.worktree)} && claude --resume ${shq(action.sessionId ?? '')} --permission-mode ${shq(cfg.attachPermissionMode)}`,
        );
      } else {
        spawnSync('claude', ['--resume', action.sessionId ?? '', '--permission-mode', cfg.attachPermissionMode], {
          cwd: action.worktree,
          stdio: 'inherit',
        });
      }
      // "background it": hand the conversation back to a headless agent
      if (store.get(action.issueId)?.status === 'interrupted') {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`resume ${action.identifier}'s agent in the background? [Y/n] `);
        rl.close();
        if (!/^n/i.test(answer.trim())) conn.dispatcher.resume(action.issueId);
      }
    } else if (action.kind === 'plan-chat') {
      // A design conversation, entered rather than typed into: the daemon cut
      // the worktree and minted the id, so a fresh session starts under that
      // id (with the primer as its opening turn) and a later visit resumes it.
      console.log(
        `${action.fresh ? 'opening' : 'resuming'} the design session for ${action.projectName}${where(cfg)}` +
          ` — quit claude (/exit) to return to colinear\n`,
      );
      const args = action.fresh
        ? ['--session-id', action.sessionId, '--permission-mode', cfg.attachPermissionMode, ...(action.primer ? [action.primer] : [])]
        : ['--resume', action.sessionId, '--permission-mode', cfg.attachPermissionMode];
      if (cfg.remote) {
        runThere(cfg.remote, `cd ${shq(action.worktree)} && claude ${args.map(shq).join(' ')}`);
      } else {
        spawnSync('claude', args, { cwd: action.worktree, stdio: 'inherit' });
      }
    } else if (action.kind === 'edit-answers') {
      openEditor(cfg, action.path);
      const answers = parseAnswerDoc(readFileSync(action.path, 'utf8'), action.count);
      conn.dispatcher.answer(action.issueId, answers);
      console.log(`sent ${answers.length} answer${answers.length > 1 ? 's' : ''}`);
    } else if (action.kind === 'edit-file') {
      if (cfg.remote) {
        // the review doc lives in the review worktree, on the daemon's host —
        // the configured editor still applies, since the config is shared
        runThere(cfg.remote, `${cfg.editor ?? '\${EDITOR:-vi}'} ${shq(action.path)}`);
      } else {
        openEditor(cfg, action.path);
      }
      conn.dispatcher.reloadReviewDoc(action.reviewId);
    } else if (action.kind === 'edit-plan') {
      if (cfg.remote) {
        // the draft lives in the daemon's state dir, on its host
        runThere(cfg.remote, `${cfg.editor ?? '\${EDITOR:-vi}'} ${shq(action.path)}`);
      } else {
        openEditor(cfg, action.path);
      }
      conn.dispatcher.reloadPlanDoc(action.projectId);
    } else if (action.kind === 'edit-config') {
      const editPath = ensureConfigFile(cfg);
      openEditor(cfg, editPath);
      Object.assign(cfg, loadConfig());
      conn.dispatcher.reloadConfig();
      console.log(`config reloaded from ${configPath()}`);
    }
  }

  conn.close();
  // agents keep running in the daemon; only this client goes away
  process.exit(reload ? RELOAD_EXIT : 0);
}

/**
 * Default entry: a thin supervisor around the TUI, so `R` can restart the
 * frontend on new code without disturbing the daemon (and its agents).
 */
function supervise(): never {
  const script = fileURLToPath(import.meta.url);
  for (;;) {
    // execArgv carries the loader in dev (tsx), where the script is .tsx
    const result = spawnSync(process.execPath, [...process.execArgv, script, '--tui'], { stdio: 'inherit' });
    if (result.status !== RELOAD_EXIT) process.exit(result.status ?? 0);
  }
}

/**
 * `coli backup [--out FILE] [--no-worktrees] [--max-file MB]` — one archive
 * holding everything a new machine needs: conversations, work in progress,
 * state and config. See core/backup.ts for what that means and why worktrees
 * are recorded rather than copied.
 */
async function backupCommand(args: string[]): Promise<void> {
  const cfg = loadConfig({ requireKey: false });
  const out = flagValue(args, '--out');
  const maxFile = flagValue(args, '--max-file');
  if (daemonPid()) {
    console.log(
      'the daemon is running — its state file is written every few seconds, so a backup\n' +
        'taken now can catch it mid-flight. `coli daemon stop` first (agents resume with r).',
    );
    process.exit(1);
  }
  console.log(`backing up to ${out ?? join(process.cwd(), defaultBackupName())}\n`);
  const { path, manifest } = await createBackup(cfg, {
    out,
    version: VERSION,
    noWorktrees: args.includes('--no-worktrees'),
    maxFileMb: maxFile ? Number.parseFloat(maxFile) : undefined,
    onProgress: (line) => console.log(`  ${line}`),
  });
  const skipped = manifest.worktrees.flatMap((w) => w.skipped);
  if (skipped.length) {
    console.log(`\n${skipped.length} untracked file(s) left out for size:`);
    for (const s of skipped.slice(0, 10)) console.log(`  ${s}`);
    if (skipped.length > 10) console.log(`  … and ${skipped.length - 10} more`);
    console.log('raise the limit with --max-file <MB> if you need them.');
  }
  console.log(
    `\n${manifest.worktrees.length} worktrees · ` +
      `${manifest.transcripts.reduce((n, t) => n + t.sessions, 0)} conversations · ` +
      `${manifest.contexts.length} context(s) · ${formatBytes(statSync(path).size)}`,
  );
  console.log(`\nrestore on the other machine with:\n  coli restore ${basename(path)}`);
}

/**
 * `coli restore FILE [--dry-run] [--clone] [--list]` — put it all back.
 *
 * Refuses across colinear versions and across operating systems, which is the
 * bargain that keeps this honest: a patch and a transcript both assume the
 * thing that wrote them. Everything it would overwrite is moved aside as
 * `<name>.before-restore` first.
 */
async function restoreCommand(args: string[]): Promise<void> {
  const archive = args.find((a) => !a.startsWith('--'));
  if (!archive || !existsSync(archive)) {
    console.error(`usage: coli restore <archive.tar.gz> [--dry-run] [--clone] [--list]`);
    process.exit(1);
  }
  if (args.includes('--list')) {
    const m = await readManifest(archive);
    console.log(`colinear ${m.colinear} · ${m.platform} · ${m.host} · ${m.createdAt}`);
    console.log(`home ${m.home}`);
    for (const c of m.contexts) console.log(`  context ${c.name}`);
    for (const r of m.repos) console.log(`  repo    ${r.name} → ${r.path}`);
    for (const w of m.worktrees) {
      console.log(
        `  wt      ${w.branch} (${w.commits} commits, ${w.dirtyFiles} modified, ${w.untrackedFiles} untracked)`,
      );
    }
    const sessions = m.transcripts.reduce((n, t) => n + t.sessions, 0);
    console.log(`  chats   ${sessions} in ${m.transcripts.length} directories`);
    return;
  }
  if (daemonPid()) {
    console.log('the daemon is running — `coli daemon stop` before restoring over its state.');
    process.exit(1);
  }
  const dryRun = args.includes('--dry-run');
  const plan = await restoreBackup({
    archive,
    version: VERSION,
    dryRun,
    clone: args.includes('--clone'),
    onProgress: (line) => console.log(`  ${line}`),
  });
  console.log('');
  for (const item of plan) {
    console.log(`  ${item.blocked ? '✖' : dryRun ? '·' : '✓'} ${item.what.padEnd(13)} ${item.detail}`);
    if (item.blocked) console.log(`      ${item.blocked}`);
  }
  const blocked = plan.filter((p) => p.blocked);
  if (dryRun) {
    console.log(`\nnothing was written — drop --dry-run to do it${blocked.length ? ' (the ✖ lines will still fail)' : ''}`);
  } else if (blocked.length) {
    console.log(`\n${blocked.length} item(s) need you — fix them and re-run; what succeeded is left in place.`);
  } else {
    console.log('\nrestored. `coli` to start the daemon and see the board.');
  }
}

/** The value after a flag, or undefined. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * The context selector is resolved in core/context.ts (it has to be, so paths
 * derive from it) and travels to children in the environment — strip it here
 * so it can sit anywhere on the command line without becoming the command.
 */
function stripContextFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--context' || arg === '-c') i++; // skip the flag and its value
    else if (!arg.startsWith('--context=')) out.push(arg);
  }
  return out;
}

const argv = stripContextFlags(process.argv.slice(2));
const [command, sub] = argv;
if (command === 'daemon') await daemonCommand(sub);
else if (command === 'gc') await gcCommand(argv.slice(1));
else if (command === 'contexts') contextsCommand();
else if (command === 'init') await runInit({ yes: argv.includes('--yes') || argv.includes('-y') });
else if (command === 'issue') await issueCommand(argv.slice(1));
else if (command === 'backup') await backupCommand(argv.slice(1));
else if (command === 'restore') await restoreCommand(argv.slice(1));
else if (command === 'demo') demoCommand();
else if (command === '--tui') await runTui();
else supervise();
