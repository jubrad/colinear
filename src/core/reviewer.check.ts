import { leadFinding, reviewBody, staleAnchors } from './reviewer.js';
import { parsePrSpec } from './reviews.js';
import type { Review, ReviewFinding } from './types.js';

/**
 * An `info` finding must never reach GitHub. Not by any path.
 *
 * `info` is the one severity written for the operator rather than the author:
 * it explains what the code does so a human can judge the change. Posted to
 * the PR it reads as review feedback, which is the single thing it is not.
 *
 * It has escaped twice. Both times the renderer was innocent and a caller
 * handed it the wrong list — most recently the fallback taken when GitHub
 * rejects a review's inline comments, which passed every finding instead of
 * the postable ones and published three annotations onto a real pull request
 * as part of an approval. So this checks the guarantee at the renderer, over
 * every caller shape that exists and one that should not, because that is the
 * level the guarantee has to hold at.
 *
 * That fallback is gone — a rejected anchor is now handed back to the agent
 * that wrote it — so the second half of this file checks the detector that
 * decides which failures are anchors and which are everything else.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const INFO_ONE = 'PRECEDENCE-IS-SET-IN-CONFIG-MERGE';
const INFO_TWO = 'THIS-CACHE-IS-KEYED-BY-EPOCH';
const BLOCKING = 'THIS-UNWRAPS-ON-USER-INPUT';
const LOOSE = 'NO-PARTICULAR-PLACE';

const lead = { comment: 'Overall this looks right.' } as ReviewFinding;
const findings: ReviewFinding[] = [
  lead,
  { file: 'src/a.rs', line: 12, comment: BLOCKING, severity: 'blocking' },
  { file: 'src/b.rs', line: 40, comment: INFO_ONE, severity: 'info' },
  { file: 'src/c.rs', line: 9, comment: INFO_TWO, severity: 'info' },
  { comment: LOOSE, severity: 'consider' } as ReviewFinding,
];

const review = {
  repository: 'MaterializeInc/materialize',
  number: 38556,
  findings,
  summary: 'A summary of the change, written for the operator.',
} as unknown as Review;

const anchored = findings.filter((f) => f.severity !== 'info' && f.file && f.line);
const loose = findings.filter((f) => f.severity !== 'info' && (!f.file || !f.line));

/** Every shape a caller has ever passed as `unanchored`, and the wrong one. */
const shapes: Array<[string, ReviewFinding[]]> = [
  ['the normal path passes the loose findings', loose],
  ['the fallback passes everything postable', findings.filter((f) => f.severity !== 'info')],
  ['a caller that passes the raw finding list', findings],
  ['a caller that passes only annotations', findings.filter((f) => f.severity === 'info')],
];

for (const [what, unanchored] of shapes) {
  for (const event of ['APPROVE', 'COMMENT', 'REQUEST_CHANGES'] as const) {
    const body = reviewBody(review, unanchored, event, false);
    check(
      `no annotation reaches an ${event.toLowerCase()} body when ${what}`,
      !body.includes(INFO_ONE) && !body.includes(INFO_TWO),
      body.slice(0, 400),
    );
    check(
      `and no annotation is counted when ${what}`,
      !/\bnotes?\b/.test(body),
      body.slice(0, 200),
    );
  }
}

// the other half of the bargain: filtering must not swallow real feedback
const fallback = reviewBody(review, findings.filter((f) => f.severity !== 'info'), 'APPROVE', false);
check('the fallback still carries an anchored finding into the body', fallback.includes(BLOCKING), fallback);
check('and still carries an unanchorable one', fallback.includes(LOOSE), fallback);
check('and still counts what it raised', /1 must fix/.test(fallback), fallback);
check('the lead sentence opens the body', fallback.startsWith('Overall this looks right.'), fallback.slice(0, 80));

// a review whose only findings are annotations has nothing to say to the author
const annotationsOnly = {
  ...review,
  findings: [lead, findings[2], findings[3]],
} as unknown as Review;
const quiet = reviewBody(annotationsOnly, [findings[2], findings[3]], 'APPROVE', false);
check('an annotations-only review posts no findings section', !quiet.includes('## Other'), quiet);
check('and no summary count', !quiet.includes('## Summary'), quiet);
check(
  'and still says the one thing meant for the author',
  quiet.trim() === 'Overall this looks right.',
  JSON.stringify(quiet),
);

check('the lead is the finding with no file, line or severity', leadFinding(findings) === lead);

/**
 * The other half: a rejected post is only handed back to the agent when it was
 * rejected for anchors. Read too broadly it would swallow a real failure —
 * auth, a closed PR — into a re-anchor that cannot help; read too narrowly it
 * falls through to a plain failure and the operator re-posts into the same
 * rejection.
 *
 * These are the shapes `gh api` actually hands back, wrapped as execFile
 * rejects them: the message carries the command, and the body arrives on
 * stderr.
 */
const rejected = (stderr: string) =>
  Object.assign(new Error('Command failed: gh api --method POST /repos/o/r/pulls/1/reviews'), { stderr });

const ANCHOR_ERRORS: Array<[string, string]> = [
  ['a line outside the diff', '{"message":"Unprocessable Entity","errors":[{"resource":"PullRequestReviewComment","field":"pull_request_review_thread.line","code":"invalid","message":"pull_request_review_thread.line must be part of the diff"}]}'],
  ['a block whose start is outside it', 'pull_request_review_thread.start_line must be part of the diff'],
  ['a file the diff does not touch', 'pull_request_review_thread.path is not part of the diff'],
];
for (const [what, stderr] of ANCHOR_ERRORS) {
  check(`${what} is recognised as a stale anchor`, staleAnchors(rejected(stderr)), stderr.slice(0, 120));
}

const OTHER_ERRORS: Array<[string, string]> = [
  ['a permission failure', '{"message":"Resource not accessible by integration","status":"403"}'],
  ['a closed pull request', '{"message":"Unprocessable Entity","errors":[{"resource":"PullRequestReview","code":"custom","message":"Can not approve your own pull request"}]}'],
  ['a network failure', 'error connecting to api.github.com'],
  ['a missing gh', 'spawn gh ENOENT'],
];
for (const [what, stderr] of OTHER_ERRORS) {
  check(`${what} is not mistaken for one`, !staleAnchors(rejected(stderr)), stderr.slice(0, 120));
}
check('and neither is nothing at all', !staleAnchors(new Error('Command failed: gh api')));

/**
 * What the operator types to pull a pull request onto the review list. It is
 * whatever was in the command bar, so the parser has to take the three forms
 * a PR is written in and reject the rest without throwing — including the
 * plain review id, which is the form `:reviews <id>` already used to select a
 * row and must keep meaning that.
 */
const SPECS: Array<[string, string | undefined, number | undefined]> = [
  ['MaterializeInc/materialize#38556', 'MaterializeInc/materialize', 38556],
  ['jubrad/colinear#104', 'jubrad/colinear', 104],
  ['jubrad/colinear/pull/104', 'jubrad/colinear', 104],
  ['https://github.com/jubrad/colinear/pull/104', 'jubrad/colinear', 104],
  ['https://github.com/jubrad/colinear/pull/104/', 'jubrad/colinear', 104],
  ['  jubrad/colinear#104  ', 'jubrad/colinear', 104],
  ['jubrad/coli.near#7', 'jubrad/coli.near', 7],
  // not pull requests
  ['jubrad/colinear', undefined, undefined],
  ['#104', undefined, undefined],
  ['104', undefined, undefined],
  ['jubrad/colinear#0', undefined, undefined],
  ['jubrad/colinear#abc', undefined, undefined],
  ['', undefined, undefined],
  ['doc:jubrad/colinear#104', undefined, undefined],
];
for (const [spec, repository, number] of SPECS) {
  const got = parsePrSpec(spec);
  check(
    repository ? `${spec.trim() || '(empty)'} parses` : `${spec.trim() || '(empty)'} is not a pull request`,
    repository ? got?.repository === repository && got?.number === number : got === undefined,
    JSON.stringify(got),
  );
}

if (failures.length) {
  console.error(`review posting: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — no info finding reaches a review body, only a stale anchor is read as one,\n     and a PR spec parses in every form the operator writes it',
);
