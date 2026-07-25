import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, PrInfo } from './types.js';
import { store } from './store.js';

const exec = promisify(execFile);

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  statusCheckRollup: Array<{ conclusion?: string; status?: string }> | null;
}

/** Fetch all open/merged PRs once and match them to tasks by branch. */
export async function pollPrs(cfg: Config): Promise<void> {
  let prs: GhPr[];
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr', 'list',
        '--state', 'all',
        '--limit', '100',
        '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,statusCheckRollup',
      ],
      { cwd: cfg.repo, maxBuffer: 10 * 1024 * 1024 },
    );
    prs = JSON.parse(stdout);
  } catch {
    return; // gh unavailable or transient failure; try again next poll
  }

  const byHead = new Map(prs.map((pr) => [pr.headRefName, pr]));

  for (const task of store.list()) {
    if (!task.branch) continue;
    // Walk the stack: the task's PR plus anything based on it.
    const chain: GhPr[] = [];
    const root = byHead.get(task.branch);
    if (root) {
      chain.push(root);
      let frontier = [root.headRefName];
      while (frontier.length) {
        const next = prs.filter((pr) => frontier.includes(pr.baseRefName) && !chain.includes(pr));
        chain.push(...next);
        frontier = next.map((pr) => pr.headRefName);
      }
    }
    const infos: PrInfo[] = chain.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      checksStatus: rollupStatus(pr.statusCheckRollup),
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    }));
    const changed = JSON.stringify(infos) !== JSON.stringify(task.prs);
    if (changed) store.update(task.issue.id, { prs: infos });
    if (infos.some((pr) => pr.state === 'OPEN') && (task.status === 'done' || task.status === 'checks')) {
      store.setStatus(task.issue.id, 'pr_open');
    }
    if (infos.length && infos.every((pr) => pr.state === 'MERGED') && task.status === 'pr_open') {
      store.setStatus(task.issue.id, 'done');
    }
  }
}

function rollupStatus(rollup: GhPr['statusCheckRollup']): string {
  if (!rollup || rollup.length === 0) return 'no checks';
  if (rollup.some((c) => c.conclusion === 'FAILURE')) return 'failing';
  if (rollup.some((c) => c.status && c.status !== 'COMPLETED')) return 'running';
  return 'passing';
}

export function startPrPolling(cfg: Config, intervalMs = 60_000): () => void {
  void pollPrs(cfg);
  const timer = setInterval(() => void pollPrs(cfg), intervalMs);
  return () => clearInterval(timer);
}
