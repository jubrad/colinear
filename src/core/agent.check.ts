import { fallbackFor, outOfAllowance } from './agent.js';

/**
 * A fallback model that equals the primary is not a harmless no-op.
 *
 * The agent SDK rejects it before the session starts:
 *
 *     Fallback model cannot be the same as the main model. Please specify a
 *     different model for fallbackModel option.
 *
 * That throw is the whole reason this resolver exists. `fallbackModel` is one
 * operator-wide setting while the model is per task (`m`) and per dispatch
 * (`c`), so the two meet at runtime and nothing in the config file can stop
 * them matching: pin `fallbackModel` to opus, switch one task onto opus, and
 * without this filter that task fails outright instead of simply having
 * nowhere to demote to. A setting meant to make failure rarer would have
 * become a new way to fail.
 *
 * The CLI itself validates none of this — `--fallback-model` accepts any
 * string and only resolves it if the primary actually becomes unavailable —
 * so a typecheck proves nothing here and the guard has to be exercised.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const eq = (name: string, got: string | undefined, want: string | undefined): void =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// the ordinary case: an expensive pinned model demotes to whatever Claude Code
// would have picked on its own
eq('a pinned model falls back to the default', fallbackFor('fable', 'default'), 'default');
eq('and to a named model', fallbackFor('fable', 'sonnet'), 'sonnet');

// the throw, in both the shapes an operator can reach it
eq('a fallback equal to the model is dropped', fallbackFor('opus', 'opus'), undefined);
eq('and dropped out of a list', fallbackFor('opus', 'opus,sonnet'), 'sonnet');
eq('leaving nothing when the list is only the model', fallbackFor('opus', 'opus, opus'), undefined);
eq('whitespace does not smuggle it past', fallbackFor(' opus ', 'opus , sonnet'), 'sonnet');

// no explicit model means the session is already on the default one
eq('no model and the default fallback is nothing to do', fallbackFor(undefined, 'default'), undefined);
eq('but a named fallback still means something', fallbackFor(undefined, 'sonnet'), 'sonnet');

// off, and unset
eq('an empty fallback is off', fallbackFor('fable', ''), undefined);
eq('an unset one is off', fallbackFor('fable', undefined), undefined);
eq('and off stays off with no model either', fallbackFor(undefined, undefined), undefined);

/**
 * The guarantee itself, over every pairing the UI can produce. The model
 * pickers in DispatchModal and EditTaskModal offer these four, the config file
 * takes any string, and `default` is what an unset model resolves to — so this
 * is the whole space where the two can collide.
 */
const MODELS = ['sonnet', 'opus', 'fable', 'haiku', 'claude-fable-5-1', 'default'];
for (const model of [...MODELS, undefined]) {
  for (const fallback of [...MODELS, 'opus,sonnet', 'fable,opus,sonnet', '', undefined]) {
    const got = fallbackFor(model, fallback);
    const names = got?.split(',') ?? [];
    check(
      `${String(model)} never falls back to itself (fallback ${JSON.stringify(fallback)})`,
      !names.includes(model ?? 'default'),
      JSON.stringify(got),
    );
    check(
      `${String(model)} produces no empty entry (fallback ${JSON.stringify(fallback)})`,
      names.every((name) => name.trim().length > 0),
      JSON.stringify(got),
    );
  }
}

/**
 * Which failures are a spent allowance, and which are an overload.
 *
 * They want opposite remedies — demote the session, or wait and retry the same
 * model — and the wording overlaps enough that one pattern catches both if it
 * is written carelessly: "rate limit reached" satisfies "limit reached". The
 * first string below is the one Claude Code actually returns, captured from a
 * genuinely exhausted allowance; the SDK's own `fallbackModel` does not rescue
 * it, which is why colinear has to recognise it at all.
 */
const SPENT: string[] = [
  "Error: Claude Code returned an error result: You've hit your monthly spend limit. Switch to another model to continue.",
  'Claude AI usage limit reached|1757308800',
  'You have hit your 5-hour limit reached for this model',
  'quota limit exceeded for this model',
];
for (const text of SPENT) {
  check(`recognised as a spent allowance: ${text.slice(0, 44)}`, outOfAllowance(new Error(text)), text.slice(0, 90));
}

const TRANSIENT: string[] = [
  'API Error: 429 rate_limit_error',
  '429 {"type":"error","error":{"type":"rate_limit_error"}}',
  'Overloaded',
  '529 overloaded_error',
  'rate limit reached, retry after 30s',
];
for (const text of TRANSIENT) {
  check(`an overload is not a spent allowance: ${text.slice(0, 40)}`, !outOfAllowance(new Error(text)), text.slice(0, 90));
}

const UNRELATED: string[] = [
  'No conversation found',
  'spawn claude ENOENT',
  'Fallback model cannot be the same as the main model.',
  'error connecting to api.anthropic.com',
];
for (const text of UNRELATED) {
  check(`an ordinary failure is not a spent allowance: ${text.slice(0, 36)}`, !outOfAllowance(new Error(text)), text);
}

if (failures.length) {
  console.error(`fallback model: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — a session never falls back to the model it is already running, which the\n     agent SDK rejects outright; an unset model has nothing to demote to; and a\n     spent allowance is told apart from an overload, which wants the opposite remedy',
);
