import { runtimeFor } from './agent.js';
import type { Config, ModelChoice, ModelScope } from './types.js';

/**
 * The model for one kind of session: what the operator named for this scope,
 * else what they named for everything. Shaped after `guidanceFor` — same
 * general-plus-scope idea — except a model replaces rather than adds to the
 * general answer, because a session runs on exactly one.
 */
export function modelFor(choice: ModelChoice, scope: ModelScope): string | undefined {
  // A scope named with an empty string is the operator switching it off, which
  // is not the same as never naming it: an absent key inherits `general`, an
  // empty one resolves to nothing.
  const own = choice[scope];
  if (own !== undefined) return own || undefined;
  return choice.general || undefined;
}

/**
 * The pair a session needs, resolved together.
 *
 * They travel as one because they are only meaningful together: `fallbackFor`
 * in agent.ts has to compare them, and the agent SDK throws outright when the
 * fallback names the model it is already on. Returning both from one call is
 * what stops a caller resolving a scoped model and pairing it with a fallback
 * resolved for something else.
 *
 * `override` is the per-task choice from `m` or `c`, which outranks any scope.
 */
export function modelsFor(
  cfg: Config,
  scope: ModelScope,
  override?: string,
): { model?: string; fallbackModel?: string } {
  // Routed through the seam because a model name may carry its runtime, and
  // what the session wants is the name with that prefix taken off. Resolving
  // it here as well would be a second place for the two to disagree.
  const { model, fallbackModel } = runtimeFor(cfg, scope, override);
  return { model, fallbackModel };
}
