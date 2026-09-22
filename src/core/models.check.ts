import { normalizeModel } from './config.js';
import { modelFor, modelsFor } from './models.js';
import { fallbackFor } from './agent.js';
import type { Config, ModelScope } from './types.js';

/**
 * Which model runs which kind of session, and the one way that can go wrong.
 *
 * Scoped models make a collision that used to be impossible ordinary: the
 * model is now per kind while a fallback can be named per kind too, so the two
 * are resolved from different keys of different maps and can easily land on
 * the same name. The agent SDK throws outright when a fallback equals the
 * model it is already on, so the pairing is checked here as a whole rather
 * than trusting either resolver alone.
 *
 * The rest is the config shape: a bare string still means "for everything",
 * an unnamed scope inherits the general answer, and an empty string is the
 * operator switching a scope off — which must NOT then inherit, or turning
 * something off would silently turn it back on.
 */

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};
const eq = (name: string, got: unknown, want: unknown): void =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ---- the config shape
eq('a bare string is the general answer', normalizeModel('fable', undefined), { general: 'fable' });
eq('whitespace is trimmed', normalizeModel('  fable  ', undefined), { general: 'fable' });
eq('unset stays unset for model', normalizeModel(undefined, undefined), {});
eq('unset means "default" for a fallback', normalizeModel(undefined, 'default'), { general: 'default' });
eq('an empty string turns it off entirely', normalizeModel('', 'default'), {});
eq('a scope named empty is kept as empty', normalizeModel({ general: 'fable', review: '' }, undefined), { general: 'fable', review: '' });
eq(
  'a map is taken scope by scope',
  normalizeModel({ general: 'fable', review: 'opus', 'draft-issue': 'haiku' }, undefined),
  { general: 'fable', review: 'opus', 'draft-issue': 'haiku' },
);
eq('a map layers over the fallback default', normalizeModel({ review: 'opus' }, 'default'), { general: 'default', review: 'opus' });
eq('an unknown scope is dropped', normalizeModel({ general: 'fable', reviews: 'opus' }, undefined), { general: 'fable' });
eq('a non-string value is dropped', normalizeModel({ general: 'fable', review: 7 }, undefined), { general: 'fable' });
eq('a non-object is ignored', normalizeModel(7, 'default'), { general: 'default' });

// Switching one scope off must not inherit the general answer. Deleting the key
// instead of keeping the empty string is the bug this guards: it made turning a
// scope off silently turn it back on to whatever `general` said.
{
  const off = normalizeModel({ general: 'fable', review: '' }, undefined);
  eq('a scope switched off resolves to nothing', modelFor(off, 'review'), undefined);
  eq('while its neighbours still inherit', modelFor(off, 'work'), 'fable');
  const noFallback = normalizeModel({ review: '' }, 'default');
  eq('a fallback can be switched off for one scope', modelFor(noFallback, 'review'), undefined);
  eq('and still apply everywhere else', modelFor(noFallback, 'work'), 'default');
}

// ---- resolution
const choice = normalizeModel({ general: 'fable', review: 'opus', maintenance: 'haiku' }, undefined);
eq('a named scope wins', modelFor(choice, 'review'), 'opus');
eq('an unnamed scope inherits general', modelFor(choice, 'work'), 'fable');
eq('and so does one with no general', modelFor(normalizeModel({ review: 'opus' }, undefined), 'work'), undefined);

const cfg = {
  model: normalizeModel({ general: 'fable', review: 'opus' }, undefined),
  fallbackModel: normalizeModel({ general: 'default', review: 'sonnet' }, 'default'),
} as unknown as Config;

eq('a session gets its scope\'s pair', modelsFor(cfg, 'review'), { model: 'opus', fallbackModel: 'sonnet' });
eq('an unscoped one gets the general pair', modelsFor(cfg, 'work'), { model: 'fable', fallbackModel: 'default' });
eq('a per-task override outranks the scope', modelsFor(cfg, 'review', 'haiku'), { model: 'haiku', fallbackModel: 'sonnet' });

/**
 * The pairing, over every scope and every way an operator can collide the two.
 * `fallbackFor` is what actually protects the session, so it is checked on the
 * output of `modelsFor` rather than on hand-written pairs.
 */
const SCOPES: ModelScope[] = [
  'general', 'triage', 'work', 'maintenance', 'coordinator', 'review', 'plan', 'draft-issue', 'draft-project',
];
const COLLIDING: Array<Record<string, string>> = [
  { general: 'opus' },
  { general: 'fable', review: 'opus' },
  { general: 'default' },
  { general: 'fable', work: 'default', review: 'sonnet' },
];
for (const models of COLLIDING) {
  for (const fallbacks of COLLIDING) {
    const c = {
      model: normalizeModel(models, undefined),
      fallbackModel: normalizeModel(fallbacks, 'default'),
    } as unknown as Config;
    for (const scope of SCOPES) {
      for (const override of [undefined, 'opus', 'default']) {
        const pair = modelsFor(c, scope, override);
        const resolved = fallbackFor(pair.model, pair.fallbackModel);
        const names = resolved?.split(',') ?? [];
        check(
          `${scope} never falls back to the model it is on`,
          !names.includes(pair.model ?? 'default'),
          JSON.stringify({ models, fallbacks, scope, override, pair, resolved }),
        );
      }
    }
  }
}

if (failures.length) {
  console.error(`scoped models: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  ✖ ${f}`);
  process.exit(1);
}
console.log(
  'ok — a model can be named per kind of session, an unnamed kind inherits the general\n     answer, and no scope can be configured into falling back to the model it is on',
);
