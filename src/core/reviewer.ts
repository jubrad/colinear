import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { guidanceFor } from './guidance.js';
import { log } from './log.js';
import { notify } from './notify.js';
import {
  deletePendingReviews,
  fetchPrDetails,
  fetchReviewThread,
  formatThread,
  notConfigured,
  submitReview,
  viewerLogin,
  type ReviewEvent,
} from './reviews.js';
import { isDemo } from './demo.js';
import { store } from './store.js';
import { extractFencedJson, hasFenceOpening } from './fence.js';
import { questionSummary } from './types.js';
import type { ChatTurn, Config, Review, ReviewFinding, Severity } from './types.js';

const exec = promisify(execFile);

const REVIEW_FILE = '.colinear-review.md';

/** ~64KB of review is already far more than anyone reads; refuse to mirror more. */
const DOC_LIMIT = 64_000;

const SEVERITIES = new Set(['blocking', 'consider', 'nit', 'praise']);

/** ```findings preferred, ```json accepted. */
const FENCE_NAMES = ['findings', 'json'];

/** Drop anything that isn't a finding rather than posting malformed comments. */
function validFindings(value: unknown): ReviewFinding[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { findings?: unknown })?.findings)
      ? (value as { findings: unknown[] }).findings
      : [];
  return list.flatMap((raw) => {
    const f = raw as Partial<ReviewFinding>;
    // the comment is the finding; a missing file just means it can't be
    // anchored, which is the body's job — dropping it would lose real review
    if (typeof f?.comment !== 'string' || !f.comment.trim()) return [];
    // absent severity marks the lead entry; a wrong one is just a typo
    const severity =
      f.severity === undefined || f.severity === null
        ? undefined
        : SEVERITIES.has(f.severity as string)
          ? (f.severity as Severity)
          : 'consider';
    const line = typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : undefined;
    const file = typeof f.file === 'string' && f.file.trim() ? f.file.trim() : undefined;
    return [{ file, line, severity, comment: f.comment }];
  });
}

/**
 * The doc carries the prose AND a fenced findings block, so one artifact stays
 * the source of truth. Structured output would have split them, and every chat
 * turn afterwards would need a second pass to keep the two in sync.
 */
export function parseDoc(text: string): { summary: string; findings: ReviewFinding[]; fencePresent: boolean } {
  // both shapes turn up in the fence: a bare array, and { "findings": [...] }
  const extracted = extractFencedJson(text, FENCE_NAMES);
  const findings = extracted ? validFindings(extracted.value) : [];
  const prose = (extracted ? text.slice(0, extracted.start) + text.slice(extracted.end) : text).trim();
  const summary =
    prose
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith('#')) ?? prose.slice(0, 500);
  return { summary, findings, fencePresent: Boolean(extracted) || hasFenceOpening(text, FENCE_NAMES) };
}

/**
 * Runs assisted reviews of other people's PRs: check the branch out in a
 * worktree, read the diff, and produce a summary plus findings. Nothing
 * reaches GitHub until the operator asks for it — posting and the
 * approve/request-changes verdicts are separate, explicit steps.
 */
export class Reviewer {
  private aborts = new Map<string, AbortController>();
  /** one per review with a worktree: the doc is live while anything writes it */
  private watchers = new Map<string, FSWatcher>();

  constructor(private cfg: Config) {}

  onToast?: (text: string, kind: 'info' | 'ok' | 'err') => void;

  private toast(text: string, kind: 'info' | 'ok' | 'err' = 'info') {
    this.onToast?.(text, kind);
  }

  shutdown() {
    for (const [id, controller] of this.aborts) {
      store.addReviewActivity(id, 'colinear quit — review stopped');
      controller.abort();
    }
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  /**
   * Mirror the doc as it's written. The agent rewrites the file mid-session
   * and you may edit it in another window; without this it only refreshes
   * when a turn ends, so a review appears all at once or not at all.
   */
  private watchDoc(id: string, worktree: string) {
    this.watchers.get(id)?.close();
    try {
      let timer: NodeJS.Timeout | undefined;
      // watch the directory: the file doesn't exist until the agent writes it
      const watcher = watch(worktree, (_event, filename) => {
        if (filename !== REVIEW_FILE) return;
        clearTimeout(timer);
        timer = setTimeout(() => this.absorbDoc(id), 300); // editors write in bursts
        timer.unref();
      });
      watcher.unref();
      this.watchers.set(id, watcher);
    } catch (err) {
      log(`review ${id}: cannot watch ${worktree}: ${String(err).slice(0, 80)}`);
    }
  }

  /** Abort so an interactive session can take the transcript over. */
  /**
   * Demo mode has no repo to check out and no PR to post to. Refuse rather
   * than half-succeed: a demo that quietly calls `gh api` against a made-up
   * PR is a demo that can surprise someone.
   */
  private refuseInDemo(id: string, what: string): boolean {
    if (!isDemo(this.cfg)) return false;
    store.addReviewActivity(id, `demo mode: ${what} does nothing here`);
    this.toast?.(`demo mode — ${what} is not wired to anything`, 'info');
    return true;
  }

  suspend(id: string): boolean {
    const controller = this.aborts.get(id);
    if (!controller) return false;
    controller.abort();
    store.addReviewActivity(id, 'suspended — attaching an interactive session');
    return true;
  }

  cancel(id: string): boolean {
    const controller = this.aborts.get(id);
    if (!controller) return false;
    controller.abort();
    store.addReviewActivity(id, 'cancelled by user');
    return true;
  }

  /** Pre-review: check out the PR and have an agent read the diff. */
  async start(id: string) {
    if (this.refuseInDemo(id, 'starting a pre-review')) return;
    const review = store.getReview(id);
    if (!review || this.aborts.has(id)) return;
    if (!review.repo) {
      store.updateReview(id, { status: 'error', error: notConfigured(review.repository) });
      this.toast(
        `no local clone matches ${review.repository} — check the paths in repos (the poll retries every 5m)`,
        'err',
      );
      return;
    }

    // A review that has already been sent starts a SECOND ROUND rather than a
    // clean slate: the author has your comments, and re-raising what they
    // already fixed or argued about is worse than saying nothing. The existing
    // document is the baseline to revise, so it is deliberately not cleared.
    const roundTwo = Boolean(review.posted);
    const controller = new AbortController();
    this.aborts.set(id, controller);
    store.updateReview(id, {
      status: 'reviewing',
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      ...(roundTwo ? {} : { summary: undefined, findings: undefined }),
    });

    try {
      store.addReviewActivity(id, `reading ${review.repository}#${review.number}`);
      const details = await fetchPrDetails(review);
      store.updateReview(id, {
        headRefName: details.headRefName,
        baseRefName: details.baseRefName,
        additions: details.additions,
        deletions: details.deletions,
        changedFiles: details.changedFiles,
      });

      const worktree = await this.checkout(review, id, details.headRefName, details.baseRefName);
      store.updateReview(id, { worktree });
      this.watchDoc(id, worktree);
      store.addReviewActivity(id, `reading the diff (${details.changedFiles} files, +${details.additions}/-${details.deletions})`);

      await this.excludeReviewFile(worktree);
      const result = await runSession({
        permissions: { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools },
        agent: {
          kind: 'review',
          label: `${review.repository}#${review.number}`,
          origin: roundTwo ? 'you asked for another round' : 'you pressed r',
        },
        prompt: roundTwo
          ? rereviewPrompt(this.cfg, review, details, await this.roundTwoContext(review))
          : reviewPrompt(this.cfg, review, details),
        cwd: worktree,
        // round two resumes the conversation that wrote the document: it knows
        // what it said and why, which is the whole point of not starting over
        resume: roundTwo ? review.sessionId : undefined,
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
      });

      if (controller.signal.aborted) {
        store.updateReview(id, { status: 'pending', endedAt: Date.now() });
        return;
      }
      if (result.isError) {
        store.updateReview(id, {
          status: 'error',
          error: result.errors.join('; ').slice(0, 300) || 'review session failed',
          endedAt: Date.now(),
        });
        return;
      }

      store.updateReview(id, { status: 'ready', costUsd: review.costUsd + result.costUsd, endedAt: Date.now() });
      if (!this.absorbDoc(id)) {
        // no doc written: keep the reply rather than losing the work
        store.updateReview(id, { doc: result.text, summary: result.text.slice(0, 2000), findings: [] });
      }
      const count = store.getReview(id)?.findings?.length ?? 0;
      if (roundTwo) {
        store.addReviewActivity(id, `round two ready: ${count} finding${count === 1 ? '' : 's'} now stand`);
        notify(this.cfg, `${review.repository}#${review.number}`, `re-review ready (${count})`, review.url);
      } else if (count === 0) {
        // a written review with no findings is almost always a parse failure,
        // and quietly saying "0" is how one got posted as an empty review
        store.addReviewActivity(id, '⚠ no findings parsed from the review document — check its ```findings fence');
        this.toast(`${review.repository}#${review.number}: review ready but no findings parsed`, 'err');
        notify(this.cfg, `${review.repository}#${review.number}`, `pre-review ready (${count})`, review.url);
      } else {
        store.addReviewActivity(id, `pre-review ready: ${count} finding${count === 1 ? '' : 's'}`);
        notify(this.cfg, `${review.repository}#${review.number}`, `pre-review ready (${count})`, review.url);
      }
    } catch (err) {
      store.updateReview(id, { status: 'error', error: String(err).slice(0, 300), endedAt: Date.now() });
      log(`review ${id} failed: ${err}`);
    } finally {
      this.aborts.delete(id);
    }
  }

  /**
   * Post the review to GitHub. Deterministic: the findings are already
   * structured, so this is a `gh api` call, not a session — it can't cost
   * tokens, can't drift from the document, and can't claim a success it
   * didn't have.
   */
  async post(id: string, event: ReviewEvent = 'COMMENT') {
    if (this.refuseInDemo(id, 'posting')) return;
    const review = store.getReview(id);
    if (!review) return;
    if (!review.doc && !review.summary) {
      this.toast('nothing to post yet — press r to run a pre-review', 'err');
      return;
    }
    const anchored = (review.findings ?? []).filter((f) => f.line && f.file);
    const loose = (review.findings ?? []).filter((f) => !f.line || !f.file);
    // zero findings means the fence failed to parse (or was never written):
    // what would go up is the summary — a description of the PR, not feedback.
    // That exact thing has been posted to a real PR; never again.
    if (!(review.findings ?? []).length && event !== 'APPROVE') {
      // refuse WITHOUT touching the status. Setting it to 'ready' here demoted
      // an already-posted review out of the reconcile's protected set, and the
      // next poll staled it — the refusal itself made the review disappear.
      store.updateReview(id, { error: 'no findings parsed — nothing to post' });
      store.addReviewActivity(id, 'post refused: no findings parsed from the review document');
      this.toast(`${review.repository}#${review.number}: post refused — no findings parsed (enter to inspect, e to edit)`, 'err');
      return;
    }
    const body = reviewBody(review, loose, event, anchored.length > 0);

    store.updateReview(id, { status: 'posting', error: undefined });
    try {
      const cleared = await deletePendingReviews(review);
      if (cleared) store.addReviewActivity(id, `cleared ${cleared} leftover pending review(s)`);

      let posted;
      try {
        posted = await submitReview(review, event, body, anchored, this.cfg.prSignoff, this.cfg.prSignoffScope);
      } catch (err) {
        // a comment on a line outside the diff rejects the whole review, so
        // fall back to one that says everything in the body instead
        log(`review ${id}: inline comments rejected (${String(err).slice(0, 200)})`);
        store.addReviewActivity(id, 'inline comments rejected — posting findings in the body');
        await deletePendingReviews(review).catch(() => 0);
        posted = await submitReview(
          review,
          event,
          reviewBody(review, review.findings ?? [], event, false),
          [],
          this.cfg.prSignoff,
          this.cfg.prSignoffScope,
        );
      }

      store.updateReview(id, {
        status: event === 'APPROVE' ? 'approved' : event === 'REQUEST_CHANGES' ? 'changes_requested' : 'commented',
        // the commit the author is now holding feedback on: round two diffs
        // from here, not from wherever the branch has drifted to
        posted: { at: Date.now(), event, url: posted.url, comments: anchored.length, sha: review.reviewedSha },
        error: undefined,
      });
      store.addReviewActivity(id, `posted ${event.toLowerCase()} review: ${posted.url}`);
      this.toast(`posted to ${review.repository}#${review.number}`, 'ok');
    } catch (err) {
      const message = String(err).slice(0, 300);
      store.updateReview(id, { status: 'ready', error: `post failed: ${message}` });
      store.addReviewActivity(id, `post failed: ${message}`);
      this.toast(`post failed for ${review.repository}#${review.number} — p retries`, 'err');
    }
  }

  /**
   * Talk to the agent that did the review. Resuming its session id means the
   * whole PR is still in its context, so a turn is mostly cache reads.
   */
  async chat(id: string, text: string) {
    if (this.refuseInDemo(id, 'the review chat')) return;
    const review = store.getReview(id);
    if (!review) return;
    // whatever happens next, what the operator typed goes in the transcript —
    // silently dropping it is how a message looks like it vanished
    const withTurn = (turns: ChatTurn[]) => [...(review.chat ?? []), ...turns];
    const now = Date.now();
    const typed: ChatTurn = { role: 'operator', text, at: now };

    if (!review.sessionId || !review.worktree) {
      store.updateReview(id, {
        chat: withTurn([typed, { role: 'note', text: 'No review session yet — press r to run a pre-review, then ask again.', at: now }]),
      });
      return;
    }
    if (this.aborts.has(id)) {
      store.updateReview(id, {
        chat: withTurn([typed, { role: 'note', text: 'The agent is still working on the previous turn — this one was not sent.', at: now }]),
      });
      return;
    }
    store.updateReview(id, { chat: withTurn([typed]), chatting: true });

    const controller = new AbortController();
    this.aborts.set(id, controller);
    try {
      const result = await runSession({
        permissions: { mode: this.cfg.agentPermissionMode, deny: this.cfg.denyTools },
        agent: { kind: 'review', label: `${review.repository}#${review.number}`, origin: 'you asked it something' },
        prompt: chatPrompt(text, review),
        cwd: review.worktree,
        resume: review.sessionId,
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
      });
      const reply = result.isError
        ? `(the session failed: ${result.errors.join('; ').slice(0, 200)})`
        : result.text.trim() || '(no reply)';
      const current = store.getReview(id);
      store.updateReview(id, {
        chat: [...(current?.chat ?? []), { role: 'agent', text: reply, at: Date.now() }],
        costUsd: (current?.costUsd ?? 0) + result.costUsd,
      });
      // the turn may have rewritten the doc; findings ride along inside it
      this.absorbDoc(id);
    } finally {
      this.aborts.delete(id);
      store.updateReview(id, { chatting: false });
    }
  }

  /** Approve / request changes — the same deterministic post, with an event. */
  async verdict(id: string, verdict: 'approve' | 'request-changes') {
    if (this.refuseInDemo(id, 'approve / request changes')) return;
    const review = store.getReview(id);
    if (!review) return;
    const event: ReviewEvent = verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
    // with a review written, the verdict carries it; without one it's a bare
    // approval, which GitHub still wants a body for on request-changes
    if (review.doc || review.summary) return this.post(id, event);
    try {
      await submitReview(
        review,
        event,
        review.note?.trim() || (event === 'APPROVE' ? '' : 'Requesting changes.'),
        [],
        this.cfg.prSignoff,
        this.cfg.prSignoffScope,
      );
      store.updateReview(id, {
        status: verdict === 'approve' ? 'approved' : 'changes_requested',
        error: undefined,
      });
      store.addReviewActivity(id, verdict === 'approve' ? 'approved' : 'requested changes');
      this.toast(`${verdict === 'approve' ? 'approved' : 'requested changes on'} ${review.repository}#${review.number}`, 'ok');
    } catch (err) {
      const message = String(err).slice(0, 200);
      store.updateReview(id, { error: message });
      this.toast(`gh review failed: ${message}`, 'err');
    }
  }

  /**
   * Drop the worktrees of reviews that are done with: the PR was merged,
   * closed, or taken by someone else. A posted review keeps its worktree —
   * the author may push again and you'd re-review the same PR — so only
   * `stale` releases it. Review checkouts are pure scratch and they are not
   * small (a materialize one is ~36G).
   */
  async cleanupStale() {
    for (const review of store.listReviews()) {
      if (review.status !== 'stale' || !review.worktree) continue;
      await this.removeWorktree(review.id);
    }
  }

  /** Remove a review's worktree and the branch we made for it. */
  async removeWorktree(id: string) {
    const review = store.getReview(id);
    if (!review?.worktree || !review.repo) return;
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const { path } = review.repo;
    const worktree = review.worktree;
    try {
      if (existsSync(worktree)) {
        await exec('git', ['-C', path, 'worktree', 'remove', '--force', worktree]);
      }
      await exec('git', ['-C', path, 'worktree', 'prune']).catch(() => {});
      await exec('git', ['-C', path, 'branch', '-D', `review/${review.number}`]).catch(() => {});
      store.updateReview(id, { worktree: undefined });
      store.addReviewActivity(id, 'review worktree removed');
      log(`review ${id}: removed worktree ${worktree}`);
    } catch (err) {
      log(`review ${id}: could not remove ${worktree}: ${String(err).slice(0, 200)}`);
    }
  }

  /** After a restart, pick the watches back up for reviews already checked out. */
  resumeWatching() {
    for (const review of store.listReviews()) {
      if (review.worktree && existsSync(review.worktree)) this.watchDoc(review.id, review.worktree);
    }
  }

  /** Re-read the doc after the operator edited it in $EDITOR. */
  reloadDoc(id: string) {
    // also (re)establish the watch: this is the other way a review learns it
    // has a worktree, and an unwatched doc silently stops being live
    const worktree = store.getReview(id)?.worktree;
    if (worktree && existsSync(worktree)) this.watchDoc(id, worktree);
    if (this.absorbDoc(id)) store.addReviewActivity(id, 'review doc reloaded from disk');
  }

  /** Pull the doc off disk into the store, where the UI mirrors it. */
  private absorbDoc(id: string): boolean {
    const review = store.getReview(id);
    if (!review?.worktree) return false;
    const path = join(review.worktree, REVIEW_FILE);
    if (!existsSync(path)) return false;
    const doc = readFileSync(path, 'utf8').slice(0, DOC_LIMIT);
    const { summary, findings } = parseDoc(doc);
    store.updateReview(id, { doc, summary, findings });
    return true;
  }

  /** Keep the review doc out of the PR's own git status. */
  private async excludeReviewFile(worktree: string) {
    try {
      const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir']);
      const excludePath = join(stdout.trim(), 'info', 'exclude');
      mkdirSync(dirname(excludePath), { recursive: true });
      const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      if (!existing.includes(REVIEW_FILE)) appendFileSync(excludePath, `${REVIEW_FILE}\n`);
    } catch {
      // non-fatal; the prompt also tells the agent never to commit it
    }
  }

  private callbacks(id: string): SessionCallbacks {
    return {
      onActivity: (line) => store.addReviewActivity(id, line),
      onSessionId: (sessionId) => store.updateReview(id, { sessionId }),
      onUsage: (u) => {
        const review = store.getReview(id);
        if (!review) return;
        store.updateReview(id, {
          tokens: {
            input: review.tokens.input + u.input,
            output: review.tokens.output + u.output,
            cacheRead: review.tokens.cacheRead + u.cacheRead,
            cacheWrite: review.tokens.cacheWrite + u.cacheWrite,
          },
        });
      },
      onQuestion: (question) => {
        const review = store.getReview(id);
        if (!review) return;
        notify(this.cfg, `${review.repository}#${review.number}`, `needs input: ${questionSummary(question).slice(0, 80)}`, review.url);
        const asked: ChatTurn = {
          role: 'agent',
          text: question.questions
            .map((q) =>
              q.options.length
                ? `${q.text}\n${q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')}`
                : q.text,
            )
            .join('\n\n'),
          at: Date.now(),
        };
        store.updateReview(id, {
          chat: [...(review.chat ?? []), asked],
          question: {
            ...question,
            answer: (answers: string[]) => {
              const current = store.getReview(id);
              store.updateReview(id, {
                question: undefined,
                chat: [...(current?.chat ?? []), { role: 'operator', text: answers.join(' · '), at: Date.now() }],
              });
              store.addReviewActivity(id, `↩ answered: ${answers.join(' · ').slice(0, 80)}`);
              question.answer(answers);
            },
          },
        });
      },
    };
  }

  /** A worktree on the PR's head branch, reused across re-reviews. */
  private async checkout(review: Review, id: string, head: string, base: string): Promise<string> {
    const repo = review.repo!;
    const worktree = join(repo.worktreeRoot, `review-${review.number}`);
    const remote = await this.remoteFor(repo.path, review.repository);

    // a cold fetch on a big repo runs for minutes — say so, or the card looks
    // stuck with nothing to show for it
    store.addReviewActivity(id, `fetching ${head} from ${remote}…`);
    await exec('git', ['-C', repo.path, 'fetch', remote, `${head}:refs/remotes/${remote}/${head}`]).catch(
      () => exec('git', ['-C', repo.path, 'fetch', remote]).catch(() => {}),
    );
    await exec('git', ['-C', repo.path, 'fetch', remote, base]).catch(() => {});

    if (existsSync(worktree)) {
      store.addReviewActivity(id, `reusing worktree ${worktree}`);
      await exec('git', ['-C', worktree, 'checkout', '-B', `review/${review.number}`, `${remote}/${head}`]);
      await this.recordSha(id, worktree);
      return worktree;
    }
    store.addReviewActivity(id, `creating worktree ${worktree}…`);
    mkdirSync(repo.worktreeRoot, { recursive: true });
    await exec('git', [
      '-C', repo.path,
      'worktree', 'add',
      '-B', `review/${review.number}`,
      worktree,
      `${remote}/${head}`,
    ]);
    await this.recordSha(id, worktree);
    return worktree;
  }

  /**
   * What a second round needs beyond the checkout: what changed since the
   * author got your comments, and how they answered. Both are read
   * deterministically — an agent told to "check the thread" can report having
   * read replies it never fetched.
   */
  private async roundTwoContext(review: Review): Promise<{ delta: string; thread: string }> {
    const since = review.posted?.sha ?? review.reviewedSha;
    let delta = '';
    if (since && review.worktree) {
      const { stdout } = await exec('git', ['-C', review.worktree, 'log', '--oneline', `${since}..HEAD`], {
        maxBuffer: 4 * 1024 * 1024,
      }).catch(() => ({ stdout: '' }));
      delta = stdout.trim();
    }
    const viewer = await viewerLogin().catch(() => undefined);
    const thread = formatThread(await fetchReviewThread(review, viewer));
    return { delta, thread };
  }

  /** What HEAD the document about to be written describes — a later round's anchor. */
  private async recordSha(id: string, worktree: string) {
    const { stdout } = await exec('git', ['-C', worktree, 'rev-parse', 'HEAD']).catch(() => ({ stdout: '' }));
    const sha = stdout.trim();
    if (sha) store.updateReview(id, { reviewedSha: sha });
  }

  /** The remote whose URL matches the PR's repo (forks push elsewhere). */
  private async remoteFor(path: string, repository: string): Promise<string> {
    const { stdout } = await exec('git', ['-C', path, 'remote', '-v']).catch(() => ({ stdout: '' }));
    for (const line of stdout.split('\n')) {
      const [name, url] = line.split(/\s+/);
      if (name && url?.toLowerCase().includes(repository.toLowerCase())) return name;
    }
    return 'origin';
  }
}

/** How a severity reads in the count line. */
const SEVERITY_LABEL: Record<Severity, [string, string]> = {
  blocking: ['must fix', 'must fix'],
  consider: ['consideration', 'considerations'],
  nit: ['nit', 'nits'],
  praise: ['praise', 'praise'],
};

/** The lead: no file, no line, no severity — one sentence opening the review. */
export function leadFinding(findings: ReviewFinding[]): ReviewFinding | undefined {
  const first = findings[0];
  return first && !first.file && !first.line && !first.severity ? first : undefined;
}

/**
 * The review body, kept deliberately small. The document is written for the
 * operator — an overview, and where the agent's own judgement is weakest —
 * and none of that belongs on someone else's PR. The body is the lead
 * sentence, a count of what was raised, and whatever couldn't be anchored to
 * a line; the inline comments are the review.
 */
function reviewBody(
  review: Review,
  unanchored: ReviewFinding[],
  event: ReviewEvent,
  hasInlineComments: boolean,
): string {
  const findings = review.findings ?? [];
  const lead = leadFinding(findings);
  const rest = findings.filter((f) => f !== lead);
  const parts: string[] = [];

  if (lead) parts.push(lead.comment.trim());
  else if (!hasInlineComments && review.summary?.trim()) parts.push(review.summary.trim());

  const counts = new Map<Severity, number>();
  for (const f of rest) if (f.severity) counts.set(f.severity, (counts.get(f.severity) ?? 0) + 1);
  if (counts.size) {
    const lines = (['blocking', 'consider', 'nit', 'praise'] as Severity[])
      .filter((sev) => counts.get(sev))
      .map((sev) => {
        const n = counts.get(sev)!;
        return `${n} ${SEVERITY_LABEL[sev][n === 1 ? 0 : 1]}`;
      });
    parts.push(`## Summary\n\n${lines.join('\n')}`);
  }

  const other = unanchored.filter((f) => f !== lead);
  if (other.length) {
    parts.push(
      `## Other\n\n${other
        .map((f) => {
          const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` — ` : '';
          return `**${f.severity ?? 'note'}** — ${where}${f.comment.trim()}`;
        })
        .join('\n\n')}`,
    );
  }

  if (review.note?.trim()) parts.push(review.note.trim());
  const body = parts.join('\n\n');
  // GitHub rejects a request-changes review with an empty body
  return body || (event === 'REQUEST_CHANGES' ? 'Requesting changes — see comments.' : '');
}

function findingsBlock(review: Review): string {
  return (review.findings ?? [])
    .map((f) => `- [${f.severity}] ${f.file ?? 'general'}${f.line ? `:${f.line}` : ''} — ${f.comment}`)
    .join('\n');
}

/**
 * Round two. The document already exists and the author has already read it,
 * so this revises rather than restarts: the session is resumed, the diff is
 * what landed since they got your comments, and their replies are quoted so
 * a point they answered is engaged with rather than repeated.
 */
export function rereviewPrompt(
  cfg: Config,
  review: Review,
  details: { baseRefName: string; body: string },
  context: { delta: string; thread: string },
): string {
  const since = review.posted?.sha ?? review.reviewedSha;
  return `You reviewed ${review.repository}#${review.number} before, and your review was posted to GitHub${
    review.posted ? ` on ${new Date(review.posted.at).toISOString().slice(0, 10)} (${review.posted.event})` : ''
  }. The author has since pushed changes, replied, or both. This is round two: revise your existing review at \`${REVIEW_FILE}\`, do not start it again.

## What changed since they got your comments
${
  since
    ? context.delta
      ? `Commits after ${since.slice(0, 8)}:\n${context.delta}\n\nRead that delta first: \`git diff ${since}...HEAD\`. The full PR is still \`git diff ${details.baseRefName}...HEAD\` if you need the wider context.`
      : `Nothing new has landed since ${since.slice(0, 8)} — if the conversation is the only thing that moved, say so plainly rather than inventing new findings.`
    : `The commit you reviewed wasn't recorded, so compare against the base yourself: \`git diff ${details.baseRefName}...HEAD\`.`
}

## The conversation
${context.thread}

## What to do
Go through your existing findings one at a time and decide, honestly, which of these each one is:

- **fixed** — the new commits address it. Drop it. Do not keep a finding alive to look thorough.
- **answered** — the author explained why it is fine and they are right. Drop it, and say in the prose that you were satisfied.
- **still standing** — not addressed, or the answer doesn't hold. Keep it, and if they pushed back, engage with what they actually said rather than restating the original comment.
- **new** — the new commits introduced something. Add it.

Then rewrite the document with the same three sections and a closing \`findings\` block, exactly as before — it is fully replaced each round, so it must contain everything you still want posted, not just the changes. The first entry is still the lead: one sentence, and for a second round it should say where things now stand.

Only what is in the findings array reaches GitHub. Keep your chat reply short.${guidanceFor(cfg.guidance, 'review')}`;
}

function reviewPrompt(cfg: Config, review: Review, details: { baseRefName: string; body: string }): string {
  return `You are reviewing someone else's pull request. Your working directory is a git worktree checked out on the PR's head branch.

## The pull request
${review.repository}#${review.number}: ${review.title}
Author: ${review.author}
URL: ${review.url}
Base branch: ${details.baseRefName}

Description:
${details.body?.trim() || '(none)'}

## What to do
Read the diff (\`git diff ${details.baseRefName}...HEAD\`, \`git log\`), then read enough of the surrounding code to judge the changes in context — a diff alone hides most real problems. Investigate; do not modify the PR's code, and do not post anything to GitHub. Your review goes to the operator first.

Write your review to \`${REVIEW_FILE}\` in the working directory (it is git-excluded; never commit it, and never touch any other file). **The prose in this document is for the operator only and is never posted** — it is how they decide what to send. Only the findings array at the end reaches GitHub, as one inline comment per entry.

It must be **markdown**, with these three sections as \`##\` headings, in this order:

\`\`\`markdown
## What this changes

Prose: what the PR does and how it hangs together, a few sentences. Lead with the outcome.

## What I'd look at yourself

Prose: where your judgement is weakest, or where the cost of being wrong is highest.

## Findings

### path/to/file.rs:42 — one-line summary (severity)

Why it matters, and the comment as you would write it to the author.
\`\`\`

Write prose as prose — paragraphs, not bullet fragments — and use fenced code blocks for any code you quote. Don't wrap lines by hand; the reader reflows them.

End the file with a \`findings\` block: a JSON **array**, one object per finding. This is what actually reaches GitHub — colinear posts each entry as an inline comment on that file and line, so write \`comment\` as the complete review comment you want the author to read, in markdown. The prose above is context for the operator; the array is the review.

**The first entry is the lead**: no \`file\`, no \`line\`, no \`severity\` — one sentence that opens the posted review. Say what the PR does and whether it looks sound; the author reads this first and it is the only thing they see if they read nothing else. One sentence, not a paragraph.

\`\`\`findings
[
  {"comment": "Solid change; the precedence rule between scoped and global values is the one thing worth a second look."},
  {"file": "src/x.rs", "line": 42, "severity": "blocking", "comment": "Full comment to the author, in markdown.\\n\\nParagraphs are fine."}
]
\`\`\`

Rules for the rest of the array: \`file\` is the repository-relative path exactly as it appears in the diff; \`line\` is a line **in the new version of the file** that the diff touches — omit both only when the point isn't about any particular place, and it will be posted in the review body instead; \`severity\` is one of blocking, consider, nit, praise. Keep the \`## Findings\` prose short — a line per finding is plenty, since the full text is in the array.

colinear assembles the posted body itself: your lead sentence, then a count of what you raised (\"2 considerations, 1 nit\"), then anything that had no line to attach to. Don't write those parts yourself.

Severity means:
- "blocking": a bug, a security or data-loss risk, or a contract change that would break callers. Something you would hold the PR for.
- "consider": a real improvement that is the author's call.
- "nit": small polish. Be sparing.
- "praise": worth calling out as good. Optional, at most a couple.

Report what you actually found. An empty findings list is a fine answer for a clean PR — do not invent problems to look thorough, and do not soften a real one. Keep your chat reply short; the document is the deliverable.${guidanceFor(cfg.guidance, 'review')}`;
}

function chatPrompt(text: string, review: Review): string {
  const posted = review.posted
    ? `\n\nNote: this review has ALREADY been posted to GitHub (${review.posted.event.toLowerCase()}, ${review.posted.comments} inline comment(s)): ${review.posted.url}. Editing the document now does not change what is on GitHub — the operator would have to post again. Say so if they ask for a change that would need reposting.`
    : '';
  return `The operator is reading your review and says:

${text}

Answer them directly and briefly. If what they say changes your review, update \`${REVIEW_FILE}\` — including the fenced findings block at the end, which must always match the prose. If it doesn't change the review, just answer; don't rewrite the file to look busy. Never post anything to GitHub yourself — colinear does that from the document when the operator asks.${posted}`;
}

