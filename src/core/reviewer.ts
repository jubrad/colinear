import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { guidanceFor } from './guidance.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { deletePendingReviews, fetchPrDetails, submitReview, type ReviewEvent } from './reviews.js';
import { store } from './store.js';
import type { ChatTurn, Config, Review, ReviewFinding } from './types.js';

const exec = promisify(execFile);

const REVIEW_FILE = '.colinear-review.md';

/** ~64KB of review is already far more than anyone reads; refuse to mirror more. */
const DOC_LIMIT = 64_000;

const SEVERITIES = new Set(['blocking', 'consider', 'nit', 'praise']);

/** Fenced block holding the findings — ```findings preferred, ```json accepted. */
const FENCE = /```(?:findings|json)\s*([\s\S]*?)```/g;

/** Drop anything that isn't a finding rather than posting malformed comments. */
function validFindings(value: unknown): ReviewFinding[] {
  const list = Array.isArray(value)
    ? value
    : Array.isArray((value as { findings?: unknown })?.findings)
      ? (value as { findings: unknown[] }).findings
      : [];
  return list.flatMap((raw) => {
    const f = raw as Partial<ReviewFinding>;
    if (typeof f?.file !== 'string' || typeof f?.comment !== 'string') return [];
    const severity = SEVERITIES.has(f.severity as string) ? (f.severity as ReviewFinding['severity']) : 'consider';
    const line = typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : undefined;
    return [{ file: f.file, line, severity, comment: f.comment }];
  });
}

/**
 * The doc carries the prose AND a fenced findings block, so one artifact stays
 * the source of truth. Structured output would have split them, and every chat
 * turn afterwards would need a second pass to keep the two in sync.
 */
function parseDoc(text: string): { summary: string; findings: ReviewFinding[] } {
  const fence = [...text.matchAll(FENCE)].pop();
  let findings: ReviewFinding[] = [];
  if (fence) {
    try {
      // both shapes turn up: a bare array, and { "findings": [...] }
      findings = validFindings(JSON.parse(fence[1]));
    } catch {
      // a malformed fence costs the findings list, not the review itself
    }
  }
  const prose = text.replace(FENCE, '').trim();
  const summary =
    prose
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith('#')) ?? prose.slice(0, 500);
  return { summary, findings };
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
    const review = store.getReview(id);
    if (!review || this.aborts.has(id)) return;
    if (!review.repo) {
      store.updateReview(id, { status: 'error', error: `${review.repository} is not a configured repo` });
      this.toast(`${review.repository} isn't in your repos allowlist — add it to review here`, 'err');
      return;
    }

    const controller = new AbortController();
    this.aborts.set(id, controller);
    store.updateReview(id, {
      status: 'reviewing',
      startedAt: Date.now(),
      endedAt: undefined,
      error: undefined,
      summary: undefined,
      findings: undefined,
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
        prompt: reviewPrompt(this.cfg, review, details),
        cwd: worktree,
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
      store.addReviewActivity(id, `pre-review ready: ${count} finding${count === 1 ? '' : 's'}`);
      notify(this.cfg, `${review.repository}#${review.number}`, `pre-review ready (${count})`, review.url);
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
    const review = store.getReview(id);
    if (!review) return;
    if (!review.doc && !review.summary) {
      this.toast('nothing to post yet — press r to run a pre-review', 'err');
      return;
    }
    const anchored = (review.findings ?? []).filter((f) => f.line && f.file);
    const loose = (review.findings ?? []).filter((f) => !f.line || !f.file);
    const body = reviewBody(review, loose);

    store.updateReview(id, { status: 'posting', error: undefined });
    try {
      const cleared = await deletePendingReviews(review);
      if (cleared) store.addReviewActivity(id, `cleared ${cleared} leftover pending review(s)`);

      let posted;
      try {
        posted = await submitReview(review, event, body, anchored);
      } catch (err) {
        // a comment on a line outside the diff rejects the whole review, so
        // fall back to one that says everything in the body instead
        log(`review ${id}: inline comments rejected (${String(err).slice(0, 200)})`);
        store.addReviewActivity(id, 'inline comments rejected — posting findings in the body');
        await deletePendingReviews(review).catch(() => 0);
        posted = await submitReview(review, event, reviewBody(review, review.findings ?? []), []);
      }

      store.updateReview(id, {
        status: event === 'APPROVE' ? 'approved' : event === 'REQUEST_CHANGES' ? 'changes_requested' : 'commented',
        posted: { at: Date.now(), event, url: posted.url, comments: anchored.length },
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
    const review = store.getReview(id);
    if (!review) return;
    const event: ReviewEvent = verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
    // with a review written, the verdict carries it; without one it's a bare
    // approval, which GitHub still wants a body for on request-changes
    if (review.doc || review.summary) return this.post(id, event);
    try {
      await submitReview(review, event, review.note?.trim() || (event === 'APPROVE' ? '' : 'Requesting changes.'), []);
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
        notify(this.cfg, `${review.repository}#${review.number}`, `needs input: ${question.text.slice(0, 80)}`, review.url);
        const asked: ChatTurn = {
          role: 'agent',
          text: question.options.length
            ? `${question.text}\n${question.options.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`
            : question.text,
          at: Date.now(),
        };
        store.updateReview(id, {
          chat: [...(review.chat ?? []), asked],
          question: {
            ...question,
            answer: (a: string) => {
              const current = store.getReview(id);
              store.updateReview(id, {
                question: undefined,
                chat: [...(current?.chat ?? []), { role: 'operator', text: a, at: Date.now() }],
              });
              store.addReviewActivity(id, `↩ answered: ${a.slice(0, 80)}`);
              question.answer(a);
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
    return worktree;
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

/**
 * What GitHub shows as the review body: the document as written, minus the
 * machine-readable fence, plus any finding we couldn't anchor to a line.
 */
function reviewBody(review: Review, inBody: ReviewFinding[]): string {
  // everything above the findings section: the findings themselves go out as
  // inline comments, and repeating them in the body is what turned a review
  // into one enormous comment
  const doc = (review.doc ?? review.summary ?? '')
    .replace(FENCE, '')
    .split(/^##\s+Findings\s*$/im)[0]
    .trim();
  const extra = inBody.length
    ? `\n\n## Further notes\n\n${inBody
        .map((f) => `- **${f.severity}** ${f.file}${f.line ? `:${f.line}` : ''} — ${f.comment}`)
        .join('\n')}`
    : '';
  const note = review.note?.trim() ? `\n\n---\n\n${review.note.trim()}` : '';
  return `${doc}${extra}${note}`.trim();
}

function findingsBlock(review: Review): string {
  return (review.findings ?? [])
    .map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.comment}`)
    .join('\n');
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

Write your review to \`${REVIEW_FILE}\` in the working directory (it is git-excluded; never commit it, and never touch any other file). The operator reads this document — write it for them, not for a log.

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

\`\`\`findings
[
  {"file": "src/x.rs", "line": 42, "severity": "blocking", "comment": "Full comment to the author, in markdown.\\n\\nParagraphs are fine."}
]
\`\`\`

Rules for the array: \`file\` is the repository-relative path exactly as it appears in the diff; \`line\` is a line **in the new version of the file** that the diff touches (omit it only if the point isn't about a specific line — those go in the review body instead); \`severity\` is one of blocking, consider, nit, praise. Keep the \`## Findings\` prose short — a line per finding is plenty, since the full text is in the array.

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

