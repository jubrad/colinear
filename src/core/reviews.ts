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
  headRefOid: string;
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
      headRefOid
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

/** The one spelling of "no local clone for this PR", so the poll can recognise
    the error it is curing rather than string-matching a near-copy. */
export const notConfigured = (repository: string) => `${repository} is not a configured repo`;

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
    // a path that doesn't exist yet (bad config, repo not cloned) must not be
    // remembered as "has no remotes" — that outlives the fix and the operator
    // is then told the repo isn't in the allowlist, which sends them to the
    // wrong file entirely
    log(`review: could not read remotes for ${repo.name} at ${repo.path}: ${String(err).slice(0, 80)}`);
    return [];
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
let recoveredOnce = false;

export async function pollReviewRequests(cfg: Config): Promise<void> {
  if (!recoveredOnce) {
    recoveredOnce = true;
    await recoverPostedReviews().catch((err) => log(`review recovery failed: ${String(err).slice(0, 160)}`));
  }
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
      headSha: pr.headRefOid,
      // it came back from a review-requested search, so it is asking for yours
      requested: true,
    };
    if (existing) {
      // A review whose repo never resolved is stuck: the config it needed may
      // since have been fixed, or the repo cloned, and nothing else ever looks
      // again. Re-resolving is cheap (slugs are cached per path) and it is the
      // only way that record heals — retention would otherwise be the cure.
      const healed = existing.repo ? undefined : await repoForSlug(cfg, pr.repository.nameWithOwner);
      const patch: Partial<Review> = { ...meta };
      if (healed) {
        patch.repo = { name: healed.name, path: healed.path, worktreeRoot: healed.worktreeRoot };
        // and clear the refusal it caused — but only that one, so a real
        // failure is never quietly promoted back to reviewable
        if (existing.status === 'error' && existing.error === notConfigured(pr.repository.nameWithOwner)) {
          patch.status = 'pending';
          patch.error = undefined;
        }
        log(`review ${id}: repo resolved to ${healed.name}`);
      }
      // metadata only: status, findings and worktree belong to the operator
      if (JSON.stringify({ ...existing, ...patch }) !== JSON.stringify(existing)) {
        store.updateReview(id, patch);
      }
      // a PR can be pushed to and re-request review in one go, so this is
      // checked here too rather than only for the ones that left the search
      announceNewCommits(id, pr.headRefOid);
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
  // Investment: a posted verdict, findings written and waiting, a session that
  // can be resumed, or a checkout on disk. Absence from the search must never
  // stale these — submitting a review, suspending for attach, and answering a
  // question all fulfil or pause the request, and each has already destroyed
  // work by being read as "finished with". Absence alone only settles a review
  // nothing and nobody has touched.
  const posted = new Set(['commented', 'approved', 'changes_requested']);
  const invested = (r: Review) =>
    posted.has(r.status) ||
    r.status === 'ready' ||
    Boolean(r.sessionId) ||
    Boolean(r.findings?.length) ||
    Boolean(r.worktree);
  for (const review of store.listReviews()) {
    if (seen.has(review.id) || review.status === 'stale' || inFlight.has(review.status)) continue;
    if (invested(review)) {
      // stale only when the PR actually settles. Until then it stays on the
      // list — the author may push again, and the worktree is deliberately
      // kept for exactly that (docs/views/reviews.md)
      const current = await prCurrentState(review.repository, review.number);
      if (current.state === 'OPEN' || current.state === undefined) {
        // still open, but no longer asking: you have already had your say
        const patch: Partial<Review> = { requested: false };
        if (current.headSha) patch.headSha = current.headSha;
        store.updateReview(review.id, patch);
        announceNewCommits(review.id, current.headSha);
        continue;
      }
      const state = current.state;
      store.updateReview(review.id, { status: 'stale' });
      store.addReviewActivity(review.id, `PR ${state.toLowerCase()} — review settled`);
      continue;
    }
    store.updateReview(review.id, { status: 'stale' });
    store.addReviewActivity(review.id, 'no longer awaiting my review');
  }
}

/**
 * Un-stale reviews that were staled by the fulfilled-request bug: for a while,
 * posting a review dropped the PR out of the review-requested search and the
 * reconcile read that absence as "finished with". GitHub still knows the truth
 * — the submitted review is right there on the PR — so ask it, once per daemon
 * start: a stale review whose PR is still open and carries a review of ours
 * gets its status back from GitHub's own record.
 *
 * Bounded by what staling never touches: retention drops settled reviews after
 * 30 days, so this walks at most a month of them, once.
 */
async function recoverPostedReviews(): Promise<void> {
  const stale = store.listReviews().filter((r) => r.status === 'stale');
  if (!stale.length) return;
  const login = await viewerLogin();
  for (const review of stale) {
    let state: string | undefined;
    let mine: string | undefined;
    try {
      const { stdout } = await exec('gh', [
        'pr', 'view', String(review.number), '--repo', review.repository,
        '--json', 'state,reviews',
      ]);
      const data = JSON.parse(stdout) as {
        state?: string;
        reviews?: Array<{ author?: { login?: string }; state?: string }>;
      };
      state = data.state;
      // the LATEST of my reviews decides: an approve after a comment is an approve
      mine = (data.reviews ?? []).filter((r) => r.author?.login === login).at(-1)?.state;
    } catch {
      continue; // could not check ≠ anything; leave it stale
    }
    if (state !== 'OPEN' || !mine) continue;
    const status =
      mine === 'APPROVED' ? 'approved' : mine === 'CHANGES_REQUESTED' ? 'changes_requested' : 'commented';
    store.updateReview(review.id, { status });
    store.addReviewActivity(review.id, `recovered: review is ${status} on an open PR`);
    log(`review recovery: ${review.id} stale -> ${status}`);
  }
}

/**
 * The PR's own state, for reviews the search no longer returns. undefined on
 * any failure: "could not check" must never read as "closed", or a rate limit
 * would stale every posted review on the list.
 */
async function prCurrentState(
  slug: string,
  number: number,
): Promise<{ state?: string; headSha?: string }> {
  try {
    const { stdout } = await exec('gh', [
      'pr', 'view', String(number), '--repo', slug, '--json', 'state,headRefOid',
    ]);
    const parsed = JSON.parse(stdout) as { state?: string; headRefOid?: string };
    return { state: parsed.state || undefined, headSha: parsed.headRefOid || undefined };
  } catch {
    return {};
  }
}

/**
 * Say once when the author pushes past what you reviewed.
 *
 * The anchor is the commit your review was posted about (or, before posting,
 * the one the document was written against). `movedSince` records what has
 * already been announced, so a push is reported on the poll that finds it and
 * not on every poll thereafter.
 */
function announceNewCommits(id: string, headSha?: string): void {
  const review = store.getReview(id);
  if (!review || !headSha) return;
  const reviewed = review.posted?.sha ?? review.reviewedSha;
  if (!reviewed || headSha === reviewed) return;
  if (review.movedSince === headSha) return;
  store.updateReview(id, { movedSince: headSha });
  store.addReviewActivity(
    id,
    review.posted
      ? `the author pushed since your review (${headSha.slice(0, 8)}) — r re-reviews`
      : `the author pushed since this was written (${headSha.slice(0, 8)}) — r refreshes it`,
  );
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
/** One message in a PR's review conversation. */
export interface ThreadComment {
  author: string;
  body: string;
  /** inline comments carry a location; general discussion doesn't */
  file?: string;
  line?: number;
  /** true when it answers one of ours */
  isReply: boolean;
  at: string;
}

/**
 * The PR's conversation: inline review comments and general discussion,
 * oldest first. Read deterministically rather than by a session — an agent
 * asked to "check the thread" can report having read replies it never saw.
 */
export async function fetchReviewThread(review: Review, viewer?: string): Promise<ThreadComment[]> {
  const out: ThreadComment[] = [];
  const get = async (path: string) => {
    try {
      const { stdout } = await exec('gh', ['api', '--paginate', path], { maxBuffer: 10 * 1024 * 1024 });
      // --paginate concatenates arrays as separate JSON documents on one line
      return stdout
        .split(/(?<=\])\s*(?=\[)/)
        .flatMap((chunk) => (chunk.trim() ? (JSON.parse(chunk) as Record<string, unknown>[]) : []));
    } catch (err) {
      log(`review ${review.id}: could not read ${path}: ${String(err).slice(0, 80)}`);
      return [];
    }
  };

  const ours = new Set<number>();
  for (const c of await get(`/repos/${review.repository}/pulls/${review.number}/comments`)) {
    const user = String((c.user as { login?: string })?.login ?? '?');
    const id = Number(c.id);
    if (viewer && user === viewer) ours.add(id);
    out.push({
      author: user,
      body: String(c.body ?? ''),
      file: c.path ? String(c.path) : undefined,
      line: typeof c.line === 'number' ? c.line : undefined,
      isReply: Boolean(c.in_reply_to_id) && (!viewer || ours.has(Number(c.in_reply_to_id))),
      at: String(c.created_at ?? ''),
    });
  }
  for (const c of await get(`/repos/${review.repository}/issues/${review.number}/comments`)) {
    out.push({
      author: String((c.user as { login?: string })?.login ?? '?'),
      body: String(c.body ?? ''),
      isReply: false,
      at: String(c.created_at ?? ''),
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The thread as the re-review prompt shows it: locations, authors, replies marked. */
export function formatThread(comments: ThreadComment[], limit = 40): string {
  if (!comments.length) return '(no comments on the PR yet)';
  const shown = comments.slice(-limit);
  const head = comments.length > shown.length ? `(showing the last ${limit} of ${comments.length})\n` : '';
  return (
    head +
    shown
      .map((c) => {
        const where = c.file ? `${c.file}${c.line ? `:${c.line}` : ''}` : 'discussion';
        return `- **${c.author}** on ${where}${c.isReply ? ' (replying to your comment)' : ''}:\n  ${c.body.trim().replace(/\n/g, '\n  ')}`;
      })
      .join('\n')
  );
}

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
