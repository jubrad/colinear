import { agentFor, registerAgent, SessionInbox, type AgentBackend } from './agent.js';
import { CLAUDE_CAPABILITIES, fallbackFor, outOfAllowance } from './agents/claude.js';
import type { Config } from './types.js';

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

/**
 * The seam itself: that a second runtime could actually be dropped in.
 *
 * An interface nothing has ever been substituted through is a shape, not a
 * seam — the demo session proved only that the *type* fits, because it ignores
 * the working directory, the model, resume, cancellation and the mailbox. So
 * this registers a fake runtime and drives a real caller's path through it.
 */
{
  const ran: string[] = [];
  const fake: AgentBackend = {
    name: 'fake',
    capabilities: { ...CLAUDE_CAPABILITIES, questions: false, cost: false },
    models: ['fake-small', 'fake-large'],
    async runSession(opts) {
      ran.push(opts.model ?? 'default');
      return { text: 'ok', costUsd: 0, isError: false, errors: [], assistantTurns: 1 };
    },
  };
  registerAgent('fake', () => fake);

  const claudeCfg = { agent: undefined } as unknown as Config;
  const fakeCfg = { agent: 'fake' } as unknown as Config;

  check('an unset runtime is claude', agentFor(claudeCfg).name === 'claude', agentFor(claudeCfg).name);
  check('a named runtime is resolved', agentFor(fakeCfg).name === 'fake', agentFor(fakeCfg).name);
  check('and is cached per config object', agentFor(fakeCfg) === agentFor(fakeCfg));

  // reloadConfig mutates the same object, so a changed runtime must re-resolve
  // rather than keep handing back the instance cached against that object
  const mutating = { agent: 'fake' } as unknown as Config;
  check('the cache is keyed on the name, not just the object', agentFor(mutating).name === 'fake');
  mutating.agent = undefined;
  check('so a config edited in place re-resolves', agentFor(mutating).name === 'claude', agentFor(mutating).name);

  check(
    'an unknown runtime says so, and says what it knows',
    (() => {
      try {
        agentFor({ agent: 'nope' } as unknown as Config);
        return false;
      } catch (err) {
        return /unknown agent runtime "nope"/.test(String(err)) && /claude/.test(String(err));
      }
    })(),
  );

  // the whole point: a caller's session actually goes through the seam
  void fake.runSession({
    prompt: 'x', cwd: '/tmp', model: 'fake-large',
    callbacks: { onActivity: () => {}, onSessionId: () => {}, onQuestion: () => {} },
  });
  check('a session reaches the registered runtime', ran.includes('fake-large'), JSON.stringify(ran));

  // a runtime must answer every capability question; a missing key reads as
  // "unsupported" to `Object.entries` consumers and silently turns a feature off
  const keys = Object.keys(CLAUDE_CAPABILITIES);
  check('the fake answers every capability the real one does', keys.every((k) => k in fake.capabilities), keys.join(','));
  check(
    'and every answer is a boolean',
    Object.values(CLAUDE_CAPABILITIES).every((v) => typeof v === 'boolean'),
  );
}

/**
 * The mailbox is shared by every runtime now, so it yields plain text and the
 * adapter puts its own envelope around it. What must survive that move is the
 * delivery bookkeeping: a message is only certainly delivered once a turn has
 * completed behind it, and anything still in flight when a session dies comes
 * back rather than being lost.
 */
{
  const inbox = new SessionInbox();
  check('a message is accepted while open', inbox.push('first'));
  check('and counted as pending', inbox.pending === 1, String(inbox.pending));
  check('an undelivered message comes back', JSON.stringify(inbox.drain()) === JSON.stringify(['first']));
  check('and draining empties it', inbox.pending === 0);
  inbox.close();
  check('a closed mailbox refuses, so the caller queues it instead', !inbox.push('late'));
}

if (failures.length) {
  console.error(`fallback model: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — a second runtime resolves and runs through the seam, a session never falls back\n     to the model it is already running (which the agent SDK rejects outright), and a\n     spent allowance is told apart from an overload, which wants the opposite remedy',
);
