import { rowSpend, totalSpend } from './spend.js';
import type { SessionSpend } from './types.js';

/**
 * A run nobody priced is not a run that cost nothing.
 *
 * Every runtime colinear has ever driven reported a dollar figure, so the
 * costs view could sum a plain number and be right. That stops being true the
 * moment a second runtime reports tokens and no price: summed as zero, the
 * total still renders bold at the top of the view and is quietly too small.
 * Wrong beats missing here, which is the same rule the review body follows.
 *
 * So `undefined` and `0` are kept apart all the way through, and this checks
 * the arithmetic rather than the rendering: what a row cost, what a list of
 * rows costs, and what is admitted to be unknown in both.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const tokens = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const session = (model: string | undefined, costUsd: number | undefined, ran?: string[]): SessionSpend =>
  ({
    kind: 'work', model, startedAt: 0, endedAt: 1, tokens,
    ...(ran ? { ran } : {}),
    ...(costUsd === undefined ? {} : { costUsd }),
  }) as SessionSpend;

// a row from before the ledger existed: the stored total is all there is
eq('no ledger falls back to the stored total', rowSpend(undefined, 1.25), { costUsd: 1.25, unpriced: 0, models: [] });
eq('and an empty ledger does too', rowSpend([], 1.25), { costUsd: 1.25, unpriced: 0, models: [] });

// the ordinary case: everything priced
eq(
  'a priced ledger sums',
  rowSpend([session('fable', 1), session('opus', 0.5)], 99),
  { costUsd: 1.5, unpriced: 0, models: ['fable', 'opus'] },
);

// the case this exists for
eq(
  'an unpriced session is not summed as free',
  rowSpend([session('fable', 1), session('codex', undefined)], 99),
  { costUsd: 1, unpriced: 1, models: ['fable', 'codex'] },
);
eq(
  'a wholly unpriced row has no cost at all, rather than zero',
  rowSpend([session('codex', undefined), session('codex', undefined)], 99),
  { costUsd: undefined, unpriced: 2, models: ['codex'] },
);
check(
  'and that is undefined, not 0',
  rowSpend([session('codex', undefined)], 99).costUsd === undefined,
);

// a genuinely free run is still a number: zero and unknown are different answers
eq('a priced zero stays priced', rowSpend([session('fable', 0)], 99), { costUsd: 0, unpriced: 0, models: ['fable'] });

// models: deduplicated, ordered by first run, and an unset model is named
eq('an unset model is named rather than dropped', rowSpend([session(undefined, 1)], 0).models, ['default']);
eq(
  'models keep first-run order and do not repeat',
  rowSpend([session('opus', 1), session('fable', 1), session('opus', 1)], 0).models,
  ['opus', 'fable'],
);

// What actually answered outranks what was asked for. A session that demoted, or
// whose runtime fell back internally, must not be attributed to the model the
// operator named — that misattribution is the reason the ledger exists.
eq(
  'the model that answered wins over the one requested',
  rowSpend([session('fable', 1, ['claude-opus-5'])], 0).models,
  ['claude-opus-5'],
);
eq(
  'a session that ran on several is credited to all of them',
  rowSpend([session('fable', 1, ['claude-fable-5-1', 'claude-haiku-4-5'])], 0).models,
  ['claude-fable-5-1', 'claude-haiku-4-5'],
);
eq(
  'and the request is used only when nothing observed it',
  rowSpend([session('fable', 1, []), session('opus', 1)], 0).models,
  ['fable', 'opus'],
);

// the total across rows
eq(
  'a total sums what is priced and counts what is not',
  totalSpend([
    rowSpend([session('fable', 1)], 0),
    rowSpend([session('codex', undefined)], 0),
    rowSpend([session('fable', 0.5), session('codex', undefined)], 0),
  ]),
  { costUsd: 1.5, unpriced: 2 },
);
eq('an all-unpriced total is zero dollars and honest about it', totalSpend([rowSpend([session('codex', undefined)], 0)]), { costUsd: 0, unpriced: 1 });
eq('an empty list totals nothing', totalSpend([]), { costUsd: 0, unpriced: 0 });

/**
 * The invariant the store helpers exist to keep: a row's running total is the
 * sum of its ledger. `addSpend` advances both in one change for this reason,
 * so a priced ledger must reproduce the stored figure exactly.
 */
{
  const entries = [session('fable', 0.3), session('opus', 0.7)];
  const stored = entries.reduce((n, s) => n + (s.costUsd ?? 0), 0);
  eq('the ledger reproduces the row total', rowSpend(entries, 0).costUsd, stored);
}

if (failures.length) {
  console.error(`spend: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — a run nobody priced is counted as unknown rather than as free, a priced zero\n     stays zero, and a row total is the sum of its session ledger',
);
