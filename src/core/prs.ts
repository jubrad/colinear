import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, PrInfo } from './types.js';
import { store } from './store.js';
import { syncIssueState } from './statesync.js';

const exec = promisify(execFile);

interface GhPr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ conclusion?: string; status?: string }> | null;
}

/** Something that can dispatch a CI-fix session (the Dispatcher; injected to avoid a cycle). */
export interface CiFixer {
  fixCi(id: string): void;
}

/** Fetch all open/merged PRs once and match them to tasks by branch. */
export async function pollPrs(cfg: Config, fixer?: CiFixer): Promise<void> {
  let prs: GhPr[];
  try {
    const { stdout } = await exec(
      'gh',
      [
        'pr', 'list',
        '--state', 'all',
        '--limit', '100',
        '--json', 'number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup',
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
      reviewDecision: pr.reviewDecision ?? undefined,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
    }));
    const hadPrs = task.prs.length > 0;
    const changed = JSON.stringify(infos) !== JSON.stringify(task.prs);
    if (changed) store.update(task.issue.id, { prs: infos });
    if (!hadPrs && infos.length > 0) {
      void syncIssueState(cfg, task.issue, 'review');
    }
    if (infos.some((pr) => pr.state === 'OPEN') && (task.status === 'done' || task.status === 'checks')) {
      store.setStatus(task.issue.id, 'pr_open');
    }
    if (infos.length && infos.every((pr) => pr.state === 'MERGED') && task.status === 'pr_open') {
      store.setStatus(task.issue.id, 'done');
    }

    // CI babysitter: one fix session per red rollup; re-arms once checks recover
    const failing = infos.some((pr) => pr.state === 'OPEN' && pr.checksStatus === 'failing');
    if (failing && cfg.ciAutofix && fixer && task.status === 'pr_open' && !task.ciFixAttempted) {
      store.update(task.issue.id, { ciFixAttempted: true });
      fixer.fixCi(task.issue.id);
    } else if (!failing && task.ciFixAttempted) {
      store.update(task.issue.id, { ciFixAttempted: false });
    }
  }
}

function rollupStatus(rollup: GhPr['statusCheckRollup']): string {
  if (!rollup || rollup.length === 0) return 'no checks';
  if (rollup.some((c) => c.conclusion === 'FAILURE')) return 'failing';
  if (rollup.some((c) => c.status && c.status !== 'COMPLETED')) return 'running';
  return 'passing';
}

export function startPrPolling(cfg: Config, fixer?: CiFixer, intervalMs = 60_000): () => void {
  void pollPrs(cfg, fixer);
  const timer = setInterval(() => void pollPrs(cfg, fixer), intervalMs);
  return () => clearInterval(timer);
}
