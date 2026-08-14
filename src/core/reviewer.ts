import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runSession, type SessionCallbacks } from './agent.js';
import { guidanceFor } from './guidance.js';
import { log } from './log.js';
import { notify } from './notify.js';
import { fetchPrDetails, submitVerdict } from './reviews.js';
import { store } from './store.js';
import type { Config, Review, ReviewFinding } from './types.js';

const exec = promisify(execFile);

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['blocking', 'consider', 'nit', 'praise'] },
          comment: { type: 'string' },
        },
        required: ['file', 'severity', 'comment'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'findings'],
  additionalProperties: false,
};

/**
 * Runs assisted reviews of other people's PRs: check the branch out in a
 * worktree, read the diff, and produce a summary plus findings. Nothing
 * reaches GitHub until the operator asks for it — posting and the
 * approve/request-changes verdicts are separate, explicit steps.
 */
export class Reviewer {
  private aborts = new Map<string, AbortController>();

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
      store.addReviewActivity(id, `reading the diff (${details.changedFiles} files, +${details.additions}/-${details.deletions})`);

      const result = await runSession({
        prompt: reviewPrompt(this.cfg, review, details),
        cwd: worktree,
        outputSchema: REVIEW_SCHEMA,
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

      const parsed = result.structured as { summary?: string; findings?: ReviewFinding[] } | undefined;
      store.updateReview(id, {
        status: 'ready',
        costUsd: review.costUsd + result.costUsd,
        summary: parsed?.summary ?? result.text.slice(0, 4000),
        findings: parsed?.findings ?? [],
        endedAt: Date.now(),
      });
      const count = parsed?.findings?.length ?? 0;
      store.addReviewActivity(id, `pre-review ready: ${count} finding${count === 1 ? '' : 's'}`);
      notify(this.cfg, `${review.repository}#${review.number}`, `pre-review ready (${count})`, review.url);
    } catch (err) {
      store.updateReview(id, { status: 'error', error: String(err).slice(0, 300), endedAt: Date.now() });
      log(`review ${id} failed: ${err}`);
    } finally {
      this.aborts.delete(id);
    }
  }

  /** Post the findings as a GitHub review. Only ever runs when asked. */
  async post(id: string) {
    const review = store.getReview(id);
    if (!review || this.aborts.has(id)) return;
    if (!review.findings?.length && !review.summary) {
      this.toast('nothing to post yet — run the pre-review first', 'err');
      return;
    }
    const controller = new AbortController();
    this.aborts.set(id, controller);
    store.updateReview(id, { status: 'posting', error: undefined });
    try {
      const result = await runSession({
        prompt: postPrompt(review),
        cwd: review.worktree ?? review.repo?.path ?? process.cwd(),
        model: this.cfg.model,
        abortController: controller,
        callbacks: this.callbacks(id),
      });
      if (result.isError) {
        store.updateReview(id, { status: 'ready', error: result.errors.join('; ').slice(0, 300) });
        this.toast(`posting failed for ${review.repository}#${review.number}`, 'err');
        return;
      }
      store.updateReview(id, {
        status: 'posted',
        costUsd: (store.getReview(id)?.costUsd ?? 0) + result.costUsd,
      });
      store.addReviewActivity(id, 'comments posted to GitHub');
      this.toast(`posted review comments on ${review.repository}#${review.number}`, 'ok');
    } finally {
      this.aborts.delete(id);
    }
  }

  /** Approve / request changes — a straight gh call, no tokens spent. */
  async verdict(id: string, verdict: 'approve' | 'request-changes') {
    const review = store.getReview(id);
    if (!review) return;
    try {
      await submitVerdict(review, verdict, review.note);
      store.updateReview(id, {
        status: verdict === 'approve' ? 'approved' : 'changes_requested',
        error: undefined,
      });
      store.addReviewActivity(id, verdict === 'approve' ? 'approved' : 'requested changes');
      this.toast(
        `${verdict === 'approve' ? 'approved' : 'requested changes on'} ${review.repository}#${review.number}`,
        'ok',
      );
    } catch (err) {
      const message = String(err).slice(0, 200);
      store.updateReview(id, { error: message });
      this.toast(`gh review failed: ${message}`, 'err');
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
        store.updateReview(id, {
          question: {
            ...question,
            answer: (a: string) => {
              store.updateReview(id, { question: undefined });
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
Read the diff (\`git diff ${details.baseRefName}...HEAD\`, \`git log\`), then read enough of the surrounding code to judge the changes in context — a diff alone hides most real problems. Investigate; do not modify anything, and do not post anything to GitHub. Your findings go to the operator first.

Return:
- "summary": what this PR does and how it hangs together, in a few sentences. Lead with the outcome. Mention risk areas the operator should look at themselves.
- "findings": specific, actionable review comments. For each: the file, the line if you can pin one, a severity, and the comment as you would write it to the author.

Severity means:
- "blocking": a bug, a security or data-loss risk, or a contract change that would break callers. Something you would hold the PR for.
- "consider": a real improvement that is the author's call.
- "nit": small polish. Be sparing.
- "praise": worth calling out as good. Optional, at most a couple.

Report what you actually found. An empty findings list is a fine answer for a clean PR — do not invent problems to look thorough, and do not soften a real one.${guidanceFor(cfg.guidance, 'review')}`;
}

function postPrompt(review: Review): string {
  return `Post the review below to ${review.repository}#${review.number} using the \`gh\` CLI. It has already been approved by the operator — post it as written, and change nothing.

## Summary
${review.summary ?? '(none)'}

## Findings
${findingsBlock(review) || '(none)'}
${review.note ? `\n## Operator's note (include this verbatim in the review body)\n${review.note}` : ''}

How to post:
1. Line-anchored findings go as inline comments in a single pending review. Build them with \`gh api\` against \`/repos/${review.repository}/pulls/${review.number}/reviews\`, passing a "comments" array of {path, line, side: "RIGHT", body}. Use the summary (plus the operator's note, if any) as the review "body", and \`"event": "COMMENT"\`.
2. Findings without a line number belong in the review body under a short heading, not as inline comments.
3. If the API rejects a comment because the line is not part of the diff, drop that comment's line anchor and move it into the body rather than failing the whole review.

Do NOT approve or request changes — the operator does that. Post exactly one review. Report what you posted in your final message.`;
}
