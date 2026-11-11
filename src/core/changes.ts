/**
 * What an agent's worktree has changed, while it is changing: files, lines
 * added and removed, and how much of it is not committed yet. The board shows
 * how long an agent has been going; this is what it has to show for it.
 *
 * Read-only against the worktree — no `git add -N` to make untracked files
 * show up in a diff, because the index belongs to the agent working in it.
 * Untracked files are counted by reading them instead.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REVIEW_FILE } from './reviewer.js';
import type { WorkChanges } from './types.js';

const exec = promisify(execFile);

/** Untracked files past this many are counted, not read — a build directory someone forgot to ignore. */
const MAX_UNTRACKED_READ = 200;
/** An untracked file larger than this is a file, not lines anyone wrote. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;

const git = async (worktree: string, args: string[]) =>
  (await exec('git', ['-C', worktree, ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;

/** `--numstat` output summed: binary files count as a file and no lines. */
function sumNumstat(text: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  return { files, added, removed };
}

/**
 * The worktree against the point its branch left the base — the first range
 * whose merge base resolves — with uncommitted and untracked work included.
 * Undefined when no range resolves or git fails: no answer, rather than zero,
 * which would read as "this agent has done nothing".
 */
export async function measureChanges(worktree: string, ranges: string[]): Promise<Omit<WorkChanges, 'movedAt'> | undefined> {
  let base: string | undefined;
  for (const range of ranges) {
    const [from, to] = range.split('...');
    if (!from || !to) continue;
    try {
      base = (await git(worktree, ['merge-base', from, to])).trim();
      if (base) break;
    } catch {
      // not fetched, or no history in common: try the next
    }
  }
  if (!base) return undefined;
  // the review document is the operator's, not the agent's work
  const spec = ['--', '.', `:(exclude)${REVIEW_FILE}`];
  try {
    const [all, dirty, others] = await Promise.all([
      git(worktree, ['diff', '--numstat', base, ...spec]),
      git(worktree, ['diff', '--numstat', 'HEAD', ...spec]),
      git(worktree, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]),
    ]);
    const total = sumNumstat(all);
    const untracked = others.split('\0').filter(Boolean);
    let untrackedLines = 0;
    for (const file of untracked.slice(0, MAX_UNTRACKED_READ)) {
      const path = join(worktree, file);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_UNTRACKED_BYTES) continue;
      const body = await readFile(path).catch(() => undefined);
      if (!body || body.includes(0)) continue;
      const text = body.toString('utf8');
      untrackedLines += text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    }
    return {
      files: total.files + untracked.length,
      added: total.added + untrackedLines,
      removed: total.removed,
      uncommitted: sumNumstat(dirty).files + untracked.length,
    };
  } catch {
    return undefined;
  }
}

/** Has anything a card shows changed — so an unchanged poll writes nothing to the store. */
export function sameChanges(a: Omit<WorkChanges, 'movedAt'> | undefined, b: Omit<WorkChanges, 'movedAt'> | undefined): boolean {
  if (!a || !b) return a === b;
  return a.files === b.files && a.added === b.added && a.removed === b.removed && a.uncommitted === b.uncommitted;
}
