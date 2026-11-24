import { localRevisePrompt, publishPrompt, reviewsLocally, workPrompt } from './dispatcher.js';
import type { Config } from './types.js';
import type { Issue, PrInfo } from './types.js';
import { roundGuidance } from './reviewrounds.js';

/**
 * Reviewing a task before it is pushed rests on three prompts saying the
 * right thing: the work pass commits and stops instead of pushing, a review
 * round hands its findings back without letting the agent publish, and the
 * last turn carries everything publishing needs — including onto a PR the
 * task already has.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const issue = { id: 'i', identifier: 'APP-7', title: 't', url: 'https://tracker/APP-7' } as Issue;
const held = workPrompt('ctx', issue, 'origin', 'origin', 'main', 'local-light', false, undefined, true);
check('a held work pass is told to commit and stop', /Commit your work locally and stop there/.test(held));
check('and is not told to push or open a PR', !/gh pr create/.test(held) && !/Push the branch/.test(held));
const normal = workPrompt('ctx', issue, 'origin', 'origin', 'main', 'local-light', false, undefined, false);
check('without it the work pass still pushes and opens the draft PR', /gh pr create --draft --base main/.test(normal) && !/stop there/.test(normal));

const round1 = localRevisePrompt([{ file: 'a.ts', line: 3, severity: 'blocking', comment: 'this drops the error' }], 1, 2);
check('a review round lists what it found', /a\.ts:3\*\* \(blocking\) — this drops the error/.test(round1));
check('and says not to push yet, with another review to come', /Do NOT push/.test(round1) && /reviews the branch again/.test(round1));
check('the last round says publishing comes next', /tells you when to publish/.test(localRevisePrompt([{ severity: 'nit', comment: 'x' }], 2, 2)));

const fresh = publishPrompt(issue, 'origin', 'origin', 'main');
check('publishing a new branch pushes and opens a draft PR titled for the issue', /gh pr create --draft --base main/.test(fresh) && /APP-7:/.test(fresh));
const pr = { number: 42, headRefName: 'feat' } as PrInfo;
const onto = publishPrompt(issue, 'origin', 'origin', 'main', pr);
check('a task that already has a PR pushes onto it, never a second', /existing PR #42/.test(onto) && /Never open a second PR/.test(onto) && !/gh pr create/.test(onto));
check('publishing never promotes the PR out of draft', /never run "gh pr ready"/.test(fresh));

// the reviewer knows its round, and paces itself by it
const first = roundGuidance({ n: 1, max: 3 });
check('a reviewer is told its round and how many there are', /review round 1 of 3/.test(first));
check('the first round says to raise everything now, grouped', /everything that matters \*\*now\*\*/.test(first) && /Group related points/.test(first));
const middle = roundGuidance({ n: 2, max: 3 });
check('a middle round checks what was asked and what the fix disturbed', /Check that each was addressed/.test(middle) && /fixes break things/.test(middle));
check('and does not re-raise what was settled', /Do not raise again/.test(middle));
const last = roundGuidance({ n: 3, max: 3 });
check('the last round keeps to what would stop it shipping', /\*\*last\*\* round/.test(last) && /Raise only what would stop this change shipping/.test(last));
check('a single review, or none in a series, gets no round talk', roundGuidance({ n: 1, max: 1 }) === '' && roundGuidance(undefined) === '');

// every tier is reviewed locally by default, the CI tier included
const cfgOf = (r: Partial<Config['taskReviews']>) => ({ taskReviews: { auto: true, maxRounds: 2, beforePush: true, ciPushesFirst: false, ...r } }) as Config;
check('a local-light task is reviewed before it pushes', reviewsLocally(cfgOf({}), 'local-light'));
check('so is a CI-tier task, by default', reviewsLocally(cfgOf({}), 'ci'));
check('unless ciPushesFirst, which pushes it first', !reviewsLocally(cfgOf({ ciPushesFirst: true }), 'ci') && reviewsLocally(cfgOf({ ciPushesFirst: true }), 'local-light'));
check('and nothing holds when the cycle is off or after the push', !reviewsLocally(cfgOf({ auto: false }), 'local-light') && !reviewsLocally(cfgOf({ beforePush: false }), 'local-light'));
const heldCi = workPrompt('ctx', issue, 'origin', 'origin', 'main', 'ci', false, undefined, true);
check('a held CI-tier pass is not told to push early', !/push the branch and open the draft PR EARLY/.test(heldCi) && /after colinear's local review/.test(heldCi));
check('one that pushes first still is', /push the branch and open the draft PR EARLY/.test(workPrompt('ctx', issue, 'origin', 'origin', 'main', 'ci', false, undefined, false)));

if (failures.length) {
  console.error(`local review: ${failures.length} failed\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('ok — a held work pass commits and stops, a review round hands back without publishing,\n     the last turn pushes, and each reviewer knows its round and paces itself by it');
