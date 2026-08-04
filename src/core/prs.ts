import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config, PrInfo } from './types.js';
import { log } from './log.js';
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
}

interface GhPrDetails {
  reviewDecision: string | null;
  statusCheckRollup: Array<{ conclusion?: string; status?: string }> | null;
}

/** Something that can dispatch a CI-fix session (the Dispatcher; injected to avoid a cycle). */
export interface CiFixer {
  fixCi(id: string): void;
  /** called when polling detects a task's PRs all merged, so blocked dependents free up immediately */
  recheckBlocked?(): void;
}

/** Fetch PRs for every repo that has tasks and match them by branch. */
export async function pollPrs(cfg: Config, fixer?: CiFixer): Promise<void> {
  const repoPaths = new Set<string>(store.list().map((t) => t.repo?.path ?? cfg.repos[0].path));
  for (const repoPath of repoPaths) {
    await pollRepo(cfg, repoPath, fixer);
  }
}

async function pollRepo(cfg: Config, repoPath: string, fixer?: CiFixer): Promise<void> {
  let prs: GhPr[];
  try {
    // LIGHT fields only: statusCheckRollup/reviewDecision over a 200-PR list
    // 504s GitHub's GraphQL on big repos (that's how materialize silently
    // stopped polling) — details are fetched per MATCHED PR below instead
    const { stdout } = await exec(
      'gh',
      [
        'pr', 'list',
        '--state', 'all',
        // colinear PRs are always authored by the operator (agents use their
        // gh auth) — filtering keeps busy upstreams (materialize!) from
        // pushing our PRs past the list limit, which orphaned matched work
        '--author', '@me',
        '--limit', '200',
        '--json', 'number,title,url,state,isDraft,headRefName,baseRefName',
      ],
      { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
    );
    prs = JSON.parse(stdout);
  } catch (err) {
    log(`pr poll failed for ${repoPath}: ${String(err).slice(0, 200)}`);
    return; // gh unavailable or transient failure; try again next poll
  }

  // CI + review state per matched PR (bounded by tasks, not repo traffic)
  const details = new Map<number, GhPrDetails>();
  const fetchDetails = async (pr: GhPr): Promise<GhPrDetails> => {
    if (details.has(pr.number)) return details.get(pr.number)!;
    try {
      const { stdout } = await exec(
        'gh',
        ['pr', 'view', String(pr.number), '--json', 'reviewDecision,statusCheckRollup'],
        { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
      );
      const d = JSON.parse(stdout) as GhPrDetails;
      details.set(pr.number, d);
      return d;
    } catch (err) {
      log(`pr detail fetch failed for #${pr.number} in ${repoPath}: ${String(err).slice(0, 120)}`);
      const d: GhPrDetails = { reviewDecision: null, statusCheckRollup: null };
      details.set(pr.number, d);
      return d;
    }
  };

  const byHead = new Map(prs.map((pr) => [pr.headRefName, pr]));

  for (const task of store.list()) {
    if (!task.branch) continue;
    if ((task.repo?.path ?? cfg.repos[0].path) !== repoPath) continue;
    // Walk the stack: the task's PR plus anything based on it. Exact branch
    // match first; fall back to the issue identifier in the head ref or title
    // (agents sometimes pick their own branch names).
    const chain: GhPr[] = [];
    const ident = task.issue.identifier.toLowerCase();
    // operator pin wins; otherwise prefer live PRs — a closed duplicate must
    // not shadow the open/merged one that superseded it
    const statePref: Record<string, number> = { OPEN: 0, MERGED: 1, CLOSED: 2 };
    const candidates = task.pinnedPr
      ? prs.filter((pr) => pr.number === task.pinnedPr)
      : [
          ...(byHead.get(task.branch) ? [byHead.get(task.branch)!] : []),
          ...prs.filter(
            (pr) =>
              pr.headRefName.toLowerCase().includes(ident) ||
              pr.title.toLowerCase().startsWith(ident),
          ),
        ];
    const root = [...new Set(candidates)].sort(
      (a, b) => (statePref[a.state] ?? 3) - (statePref[b.state] ?? 3),
    )[0];
    if (root) {
      chain.push(root);
      let frontier = [root.headRefName];
      while (frontier.length) {
        const next = prs.filter((pr) => frontier.includes(pr.baseRefName) && !chain.includes(pr));
        chain.push(...next);
        frontier = next.map((pr) => pr.headRefName);
      }
    }
    const infos: PrInfo[] = await Promise.all(
      chain.map(async (pr) => {
        // merged/closed PRs don't need live CI/review state — skip the fetch
        const d = pr.state === 'OPEN' ? await fetchDetails(pr) : { reviewDecision: null, statusCheckRollup: null };
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          isDraft: pr.isDraft,
          checksStatus: rollupStatus(d.statusCheckRollup),
          reviewDecision: d.reviewDecision ?? undefined,
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName,
        };
      }),
    );
    // never wipe known PRs just because a poll window missed them
    if (!infos.length && task.prs.length) continue;
    const hadPrs = task.prs.length > 0;
    const changed = JSON.stringify(infos) !== JSON.stringify(task.prs);
    if (changed) store.update(task.issue.id, { prs: infos });
    if (!hadPrs && infos.length > 0) {
      void syncIssueState(cfg, task.issue, 'review');
    }
    // error included: pinning/discovering a live PR un-fails the task instead
    // of leaving it confused in the Failed column
    if (infos.some((pr) => pr.state === 'OPEN') && ['done', 'checks', 'error'].includes(task.status)) {
      store.update(task.issue.id, { status: 'pr_open', error: undefined });
    }
    if (
      infos.length &&
      infos.every((pr) => pr.state === 'MERGED') &&
      // merged work is done, whatever state the task was stuck in
      ['pr_open', 'error', 'escalated', 'interrupted', 'queued', 'blocked', 'needs_input'].includes(task.status)
    ) {
      store.update(task.issue.id, { status: 'done', error: undefined, question: undefined });
      fixer?.recheckBlocked?.(); // free dependents now, not on the next 60s tick
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

function rollupStatus(rollup: GhPrDetails['statusCheckRollup']): string {
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
