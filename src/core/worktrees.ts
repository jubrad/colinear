import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * What git thinks is checked out, and what is actually there.
 *
 * These disagree more often than you would like. A worktree removed by
 * anything other than `git worktree remove` — an `rm -rf`, a disk cleanup, an
 * agent that got creative, a recycled VM — leaves its **registration** behind
 * in the parent repository. `git worktree list` still names the path, still
 * names the branch, and adds `prunable` at the end; nothing acts on that
 * unless somebody prunes.
 *
 * That stale entry is worse than useless, because it is what colinear looked
 * up when asked "where does this branch live?". The answer was a directory
 * that no longer existed, so the next dispatch started an agent in it — and
 * even a deliberate `git worktree add` at the same path is refused:
 *
 *     fatal: '…' is a missing but already registered worktree;
 *     use 'add -f' to override, or 'prune' or 'remove' to clear
 *
 * So the lookup here clears what it finds. The recovery is worth having: the
 * branch is untouched by any of this, so re-adding the worktree brings back
 * every commit. What does not come back is whatever was never committed.
 */

export interface Registration {
  path: string;
  branch?: string;
  head?: string;
  /** git can see the directory is gone; the entry is bookkeeping nobody can use */
  prunable: boolean;
  /** pinned by `git worktree lock` — prune leaves these alone, so we must too */
  locked: boolean;
}

export async function registrations(repo: string): Promise<Registration[]> {
  const { stdout } = await exec('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
    maxBuffer: 8 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const out: Registration[] = [];
  for (const block of stdout.split('\n\n')) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    out.push({
      path,
      branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
      head: block.match(/^HEAD ([0-9a-f]+)$/m)?.[1],
      prunable: /^prunable /m.test(block),
      locked: /^locked/m.test(block),
    });
  }
  return out;
}

export interface Lookup {
  /** a checkout that holds this branch *and is still on disk* */
  path?: string;
  /** registrations that pointed at nothing, now cleared */
  cleared: string[];
  /** cleared registrations that held the branch we were asked about */
  lost?: { path: string; head?: string };
}

/**
 * Where `branch` is checked out — clearing any registration that turns out to
 * point at nothing on the way.
 *
 * `prunable` is git's own verdict and the one that matters, but the directory
 * is checked too: git only notices at list time, and the cheap `existsSync`
 * closes the window where it has not looked yet.
 */
export async function worktreeForBranch(repo: string, branch: string): Promise<Lookup> {
  const before = await registrations(repo);
  const dead = before.filter((r) => r.prunable || !existsSync(r.path));
  const lost = dead.find((r) => r.branch === branch);
  let cleared: string[] = [];
  if (dead.length) {
    await exec('git', ['-C', repo, 'worktree', 'prune']).catch(() => {});
    const after = await registrations(repo);
    const still = new Set(after.map((r) => r.path));
    // a locked worktree survives prune, so report only what actually went
    cleared = dead.filter((r) => !still.has(r.path)).map((r) => r.path);
  }
  const live = (await registrations(repo)).find(
    (r) => r.branch === branch && !r.prunable && existsSync(r.path),
  );
  return { path: live?.path, cleared, lost: lost ? { path: lost.path, head: lost.head } : undefined };
}

/**
 * What to tell the operator when a checkout came back from the dead.
 *
 * Said out loud on purpose. The commits return and the conversation returns —
 * the transcript is filed against the path, not the directory — but anything
 * uncommitted was only ever in that directory, and an agent picking the task
 * back up will find work it remembers doing that is no longer there.
 */
export function recoveryNote(branch: string, head?: string): string {
  return (
    `the worktree was gone — recreated it from ${branch}${head ? ` at ${head.slice(0, 7)}` : ''}. ` +
    'Committed work is back; anything uncommitted was not.'
  );
}
