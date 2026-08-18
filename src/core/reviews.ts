import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { log } from './log.js';
import { store } from './store.js';
import type { Config, RepoConfig, Review, ReviewFinding } from './types.js';

const exec = promisify(execFile);

interface SearchedPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  baseRefName: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
}

/**
 * One GraphQL query for everything the list shows. `gh search prs` omits the
 * diff stats and branch names, which would otherwise need a `gh pr view` per
 * PR — 35 extra requests just to fill in a column.
 */
const SEARCH_QUERY = `
query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft updatedAt additions deletions changedFiles
      headRefName baseRefName
      author { login }
      repository { nameWithOwner }
    } }
  }
}`;

let cachedLogin: string | undefined;

/** GraphQL search has no @me, so resolve the login once. */
export async function viewerLogin(): Promise<string> {
  if (!cachedLogin) {
    const { stdout } = await exec('gh', ['api', 'user', '-q', '.login']);
    cachedLogin = stdout.trim();
  }
  return cachedLogin;
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
    const login = await viewerLogin();
    const { stdout } = await exec(
      'gh',
      [
        'api', 'graphql',
        '-f', `query=${SEARCH_QUERY}`,
        // archived repos can't be reviewed, merged, or commented on
        '-f', `q=is:pr is:open archived:false review-requested:${login}`,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    prs = (JSON.parse(stdout).data?.search?.nodes ?? []) as SearchedPr[];
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
      author: pr.author?.login ?? 'unknown',
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      headRefName: pr.headRefName,
      baseRefName: pr.baseRefName,
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
      status: 'pending',
      activity: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      ...(repo ? { repo: { name: repo.name, path: repo.path, worktreeRoot: repo.worktreeRoot } } : {}),
      ...meta,
    });
  }

  // A PR that stopped requesting my review is *usually* finished with: merged,
  // closed, or someone else took it. The exception is the review I just posted
  // — submitting a review FULFILS the request, so the PR drops out of the
  // search at the exact moment the work succeeds. Staling on absence alone
  // therefore forgot every PR reviewed through colinear within one poll.
  const inFlight = new Set(['reviewing', 'posting', 'queued']);
  const posted = new Set(['commented', 'approved', 'changes_requested']);
  for (const review of store.listReviews()) {
    if (seen.has(review.id) || review.status === 'stale' || inFlight.has(review.status)) continue;
    if (posted.has(review.status)) {
      // posted and no longer requested: stale only when the PR actually
      // settles. Until then it stays on the list — the author may push again,
      // and the worktree is deliberately kept for exactly that (docs/views/reviews.md)
      const state = await prCurrentState(review.repository, review.number);
      if (state === 'OPEN' || state === undefined) continue;
      store.updateReview(review.id, { status: 'stale' });
      store.addReviewActivity(review.id, `PR ${state.toLowerCase()} — review settled`);
      continue;
    }
    store.updateReview(review.id, { status: 'stale' });
    store.addReviewActivity(review.id, 'no longer awaiting my review');
  }
}

/**
 * The PR's own state, for reviews the search no longer returns. undefined on
 * any failure: "could not check" must never read as "closed", or a rate limit
 * would stale every posted review on the list.
 */
async function prCurrentState(slug: string, number: number): Promise<string | undefined> {
  try {
    const { stdout } = await exec('gh', [
      'pr', 'view', String(number), '--repo', slug, '--json', 'state', '--jq', '.state',
    ]);
    const state = stdout.trim();
    return state || undefined;
  } catch {
    return undefined;
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

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

/**
 * GitHub allows one pending review per user per PR, and a leftover blocks
 * every new one. Clear ours before posting.
 */
export async function deletePendingReviews(review: Review): Promise<number> {
  const login = await viewerLogin();
  const { stdout } = await exec(
    'gh',
    [
      'api',
      `/repos/${review.repository}/pulls/${review.number}/reviews`,
      '--paginate',
      '--jq',
      `.[] | select(.user.login == "${login}" and .state == "PENDING") | .id`,
    ],
    { maxBuffer: 10 * 1024 * 1024 },
  );
  const ids = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const reviewId of ids) {
    await exec('gh', [
      'api', '--method', 'DELETE',
      `/repos/${review.repository}/pulls/${review.number}/reviews/${reviewId}`,
    ]);
  }
  return ids.length;
}

export interface PostedReview {
  id: number;
  url: string;
}

/**
 * Post a review straight to GitHub. The findings are already structured, so
 * this needs no model — which also means it either works or throws, instead
 * of a session reporting success it didn't have.
 */
export async function submitReview(
  review: Review,
  event: ReviewEvent,
  body: string,
  comments: ReviewFinding[],
  signoff?: string,
  scope: 'all' | 'body' = 'all',
): Promise<PostedReview> {
  // whoever reads a comment on their PR should know what wrote it
  const sign = (text: string) => (signoff?.trim() ? `${text}\n\n${signoff.trim()}` : text);
  const payload = {
    event,
    body: body.trim() ? sign(body) : body,
    comments: comments
      .filter((f) => f.line && f.file)
      .map((f) => {
        const text = f.severity ? `**${f.severity}** — ${f.comment}` : f.comment;
        return { path: f.file, line: f.line, side: 'RIGHT', body: scope === 'all' ? sign(text) : text };
      }),
  };
  const dir = mkdtempSync(join(tmpdir(), 'coli-review-'));
  const file = join(dir, 'review.json');
  try {
    writeFileSync(file, JSON.stringify(payload));
    const { stdout } = await exec(
      'gh',
      ['api', '--method', 'POST', `/repos/${review.repository}/pulls/${review.number}/reviews`, '--input', file],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const posted = JSON.parse(stdout) as { id: number; html_url: string };
    return { id: posted.id, url: posted.html_url };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function startReviewPolling(
  cfg: Config,
  afterPoll?: () => void | Promise<void>,
  intervalMs = 300_000,
): () => void {
  const poll = async () => {
    await pollReviewRequests(cfg);
    await afterPoll?.();
  };
  void poll();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
