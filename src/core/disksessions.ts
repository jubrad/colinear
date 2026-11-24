import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A Claude Code or Codex conversation on disk — every one, not only the ones
 * colinear started. What :sessions lists, and what `enter` resumes.
 */
export interface DiskSession {
  runtime: 'claude' | 'codex';
  /** what `claude --resume` / `codex resume` takes */
  id: string;
  /** where it ran — and where resuming it must happen */
  cwd: string;
  /** its first real prompt, one line */
  title: string;
  branch?: string;
  /** last written to */
  updatedAt: number;
  bytes: number;
  /** a person at a terminal (cli, an editor) or a program (colinear, an SDK, exec) */
  interactive: boolean;
  /** what colinear ran it for, when colinear did: a task, a review, a plan */
  label?: string;
}

/** How much of a transcript is read to describe it: the head holds the cwd and the first prompt. */
const HEAD_BYTES = 256 * 1024;

function head(path: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    // the last line is probably cut off at the byte limit
    return n === HEAD_BYTES ? lines.slice(0, -1) : lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parse(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Text from a message's content, whether a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join(' ');
  }
  return '';
}

/**
 * A prompt worth naming the conversation by. The harness's own insertions —
 * command wrappers, caveats, environment blocks, reminders — all open with a
 * tag, so anything starting `<` is skipped.
 */
export function promptTitle(text: string): string | undefined {
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return undefined;
  return t.replace(/\s+/g, ' ').slice(0, 200);
}

function listDir(path: string, dirs: boolean): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => (dirs ? e.isDirectory() : e.isFile()))
      .map((e) => join(path, e.name));
  } catch {
    return [];
  }
}

/** Newest first, capped: a year of transcripts is thousands of files, and only the recent ones are read. */
function newest(paths: string[], limit: number): Array<{ path: string; mtime: number; size: number }> {
  return paths
    .map((path) => {
      try {
        const st = statSync(path);
        return { path, mtime: st.mtimeMs, size: st.size };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is { path: string; mtime: number; size: number } => Boolean(x))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

export function describeClaude(path: string, mtime: number, size: number): DiskSession | undefined {
  const id = path.split('/').pop()!.replace(/\.jsonl$/, '');
  let cwd: string | undefined;
  let branch: string | undefined;
  let entrypoint: string | undefined;
  let title: string | undefined;
  for (const line of head(path)) {
    const d = parse(line);
    if (!d) continue;
    if (!cwd && typeof d.cwd === 'string') cwd = d.cwd;
    if (!branch && typeof d.gitBranch === 'string' && d.gitBranch) branch = d.gitBranch;
    if (!entrypoint && typeof d.entrypoint === 'string') entrypoint = d.entrypoint;
    if (!title && d.type === 'user' && !d.isSidechain) {
      const message = d.message as { role?: string; content?: unknown } | undefined;
      if (message?.role === 'user') title = promptTitle(textOf(message.content));
    }
    if (cwd && entrypoint && title) break;
  }
  if (!cwd) return undefined; // nothing ever happened in it
  return {
    runtime: 'claude',
    id,
    cwd,
    title: title ?? '(no prompt yet)',
    branch,
    updatedAt: mtime,
    bytes: size,
    // sdk-ts / sdk-py are programs: colinear's own sessions among them
    interactive: !entrypoint || !entrypoint.startsWith('sdk'),
  };
}

export function describeCodex(path: string, mtime: number, size: number): DiskSession | undefined {
  let id: string | undefined;
  let cwd: string | undefined;
  let branch: string | undefined;
  let originator: string | undefined;
  let title: string | undefined;
  for (const line of head(path)) {
    const d = parse(line);
    const p = d?.payload as Record<string, unknown> | undefined;
    if (!d || !p) continue;
    if (d.type === 'session_meta') {
      id = typeof p.id === 'string' ? p.id : id;
      cwd = typeof p.cwd === 'string' ? p.cwd : cwd;
      originator = typeof p.originator === 'string' ? p.originator : originator;
      const git = p.git as { branch?: unknown } | undefined;
      if (typeof git?.branch === 'string') branch = git.branch;
    }
    if (!title && d.type === 'response_item' && p.type === 'message' && p.role === 'user') title = promptTitle(textOf(p.content));
    if (id && cwd && title) break;
  }
  if (!id || !cwd) return undefined;
  return {
    runtime: 'codex',
    id,
    cwd,
    title: title ?? '(no prompt yet)',
    branch,
    updatedAt: mtime,
    bytes: size,
    // codex-tui is a person; codex_exec and the SDK are programs
    interactive: !originator || originator === 'codex-tui' || originator.startsWith('codex_vscode'),
  };
}

/**
 * The most recent conversations each CLI has on this machine. Claude Code
 * files them by directory under ~/.claude/projects, Codex by date under
 * ~/.codex/sessions; either may be missing.
 */
export function scanDiskSessions(limit = 300, home = homedir()): DiskSession[] {
  const out: DiskSession[] = [];
  const claudeRoot = join(home, '.claude', 'projects');
  if (existsSync(claudeRoot)) {
    const files = listDir(claudeRoot, true).flatMap((dir) => listDir(dir, false).filter((f) => f.endsWith('.jsonl')));
    for (const f of newest(files, limit)) {
      const s = describeClaude(f.path, f.mtime, f.size);
      if (s) out.push(s);
    }
  }
  const codexRoot = join(home, '.codex', 'sessions');
  if (existsSync(codexRoot)) {
    // YYYY/MM/DD/rollout-*.jsonl
    const days = listDir(codexRoot, true).flatMap((y) => listDir(y, true).flatMap((m) => listDir(m, true)));
    const files = days.flatMap((d) => listDir(d, false).filter((f) => f.endsWith('.jsonl')));
    for (const f of newest(files, limit)) {
      const s = describeCodex(f.path, f.mtime, f.size);
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
