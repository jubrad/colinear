import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './log.js';
import { store } from './store.js';
import type { Config, RepoConfig, Review } from './types.js';

const exec = promisify(execFile);

interface SearchedPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string };
  repository: { nameWithOwner: string };
}

export interface PrDetails {
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string;
}

export const reviewId = (repository: string, number: number) => `${repository}#${number}`;

/** owner/repo for each configured repo, read from its git remotes (cached). */
const slugCache = new Map<string, string[]>();

async function slugsFor(repo: RepoConfig): Promise<string[]> {
  const cached = slugCache.get(repo.path);
  if (cached) return cached;
  let slugs: string[] = [];
  try {
    const { stdout } = await exec('git', ['-C', repo.path, 'remote', '-v']);
    // both git@host:owner/name(.git) and https://host/owner/name(.git)
    slugs = [...stdout.matchAll(/[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/g)].map((m) => m[1].toLowerCase());
  } catch (err) {
    log(`review: could not read remotes for ${repo.name}: ${String(err).slice(0, 80)}`);
  }
  slugCache.set(repo.path, [...new Set(slugs)]);
  return slugCache.get(repo.path)!;
}

/**
 * The configured repo a PR belongs to, matched on git remotes rather than
 * names — a repo's colinear name rarely equals its GitHub slug.
 */
export async function repoForSlug(cfg: Config, nameWithOwner: string): Promise<RepoConfig | undefined> {
  const want = nameWithOwner.toLowerCase();
  for (const repo of cfg.repos) {
    if ((await slugsFor(repo)).includes(want)) return repo;
  }
  return undefined;
}

/**
 * PRs waiting on my review, across every repo my gh auth can see. Existing
 * reviews keep their state — only the PR metadata refreshes — so a pre-review
 * in flight is never clobbered by a poll.
 */
export async function pollReviewRequests(cfg: Config): Promise<void> {
  let prs: SearchedPr[];
  try {
    const { stdout } = await exec(
      'gh',
      [
        'search', 'prs',
        '--review-requested', '@me',
        '--state', 'open',
        // a PR in an archived repo can't be reviewed, merged, or commented on
        '--archived=false',
        '--limit', '50',
        '--json', 'number,title,url,repository,author,updatedAt,isDraft',
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    prs = JSON.parse(stdout);
  } catch (err) {
    log(`review request poll failed: ${String(err).slice(0, 200)}`);
    return;
  }

  const seen = new Set<string>();
  for (const pr of prs) {
    const id = reviewId(pr.repository.nameWithOwner, pr.number);
    seen.add(id);
    const existing = store.getReview(id);
    const meta = {
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
    };
    if (existing) {
      // metadata only: status, findings and worktree belong to the operator
      if (JSON.stringify({ ...existing, ...meta }) !== JSON.stringify(existing)) {
        store.updateReview(id, meta);
      }
      continue;
    }
    const repo = await repoForSlug(cfg, pr.repository.nameWithOwner);
    store.upsertReview({
      id,
      number: pr.number,
      repository: pr.repository.nameWithOwner,
      headRefName: '',
      baseRefName: '',
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      status: 'pending',
      activity: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      ...(repo ? { repo: { name: repo.name, path: repo.path, worktreeRoot: repo.worktreeRoot } } : {}),
      ...meta,
    });
  }

  // a PR that no longer wants my review drops off, unless I've started on it
  for (const review of store.listReviews()) {
    if (seen.has(review.id) || review.status !== 'pending') continue;
    store.updateReview(review.id, { status: 'stale' });
  }
}

/** Fields the search endpoint doesn't return; needed before checking out. */
export async function fetchPrDetails(review: Review): Promise<PrDetails> {
  const { stdout } = await exec(
    'gh',
    [
      'pr', 'view', String(review.number),
      '--repo', review.repository,
      '--json', 'headRefName,baseRefName,additions,deletions,changedFiles,body',
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as PrDetails;
}

/** Approve or request changes — deterministic, no agent involved. */
export async function submitVerdict(
  review: Review,
  verdict: 'approve' | 'request-changes',
  body?: string,
): Promise<void> {
  const args = ['pr', 'review', String(review.number), '--repo', review.repository, `--${verdict}`];
  // GitHub rejects a request-changes review with no body
  if (body?.trim()) args.push('--body', body.trim());
  else if (verdict === 'request-changes') args.push('--body', 'Requesting changes — see comments.');
  await exec('gh', args, { maxBuffer: 1024 * 1024 });
}

export function startReviewPolling(cfg: Config, intervalMs = 300_000): () => void {
  void pollReviewRequests(cfg);
  const timer = setInterval(() => void pollReviewRequests(cfg), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
