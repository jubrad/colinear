import { claudeBackend } from './agents/claude.js';
import { codexBackend } from './agents/codex.js';
import type { AgentBackend } from './agents/shared.js';
import { modelFor } from './models.js';
import type { Config, ModelScope } from './types.js';

export type {
  AgentBackend,
  AgentCapabilities,
  RunSessionOpts,
  SessionCallbacks,
  SessionResult,
} from './agents/shared.js';
export { SessionInbox } from './agents/shared.js';

/**
 * Which agent runtime runs a session.
 *
 * Everything above this file is runtime-agnostic and everything below it is
 * one adapter, the arrangement `core/provider.ts` already uses for trackers.
 * Nothing outside `core/agents/` imports an agent SDK, so the answer to "what
 * is actually running this" is asked in one place rather than assumed in
 * twelve.
 *
 * Features ask `capabilities` rather than assuming, because the runtimes
 * differ in ways that change what the work is like and not merely which key
 * is greyed out — a runtime that cannot stop and ask does not park a task in
 * `needs_input`, it guesses.
 */
type Factory = (cfg: Config) => AgentBackend;

const registry = new Map<string, Factory>([
  ['claude', claudeBackend],
  ['codex', codexBackend],
]);

/** Register a runtime. Exported for the checks, which drive fakes through the seam. */
export function registerAgent(name: string, factory: Factory): void {
  registry.set(name, factory);
}

export function knownAgents(): string[] {
  return [...registry.keys()];
}

/**
 * Every model the pickers can offer, across every runtime.
 *
 * Not just the configured one's: picking a model is how an operator sends a
 * single task to another runtime, so the list has to cross that line. Names
 * are bare because each runtime claims its own — a prefix is only needed for
 * something nothing recognises, which is not what a picker is for.
 */
export function pickableModels(cfg: Config): string[] {
  const out: string[] = [];
  for (const name of registry.keys()) {
    for (const model of agentNamed(cfg, name).models) if (!out.includes(model)) out.push(model);
  }
  return out;
}

// Per config object, then per runtime name: one config can now resolve to two
// runtimes at once, so a single cached instance per config would thrash
// between them every time a review followed a work session.
const cache = new WeakMap<Config, Map<string, AgentBackend>>();

/**
 * The runtime that runs this kind of session.
 *
 * Scoped the same way as the model, because the two answer to the same
 * question — what should run this — and because the runtimes differ in what
 * they can do rather than only in what they cost. Reviews on one and work on
 * another is a reasonable thing to want, and `AgentKind` was already on every
 * session, so it costs no new plumbing.
 *
 * Cached per config object, since `reloadConfig` mutates the same object in
 * place and a reload must keep the instance and its settings both current.
 */
export function agentFor(cfg: Config, scope: ModelScope = 'general'): AgentBackend {
  return runtimeFor(cfg, scope).backend;
}

/** What runs a session, and on what. One decision, so the two cannot disagree. */
export interface SessionRuntime {
  backend: AgentBackend;
  model?: string;
  fallbackModel?: string;
}

/**
 * Find the runtime a model name belongs to.
 *
 * Three ways, in order. An explicit `runtime/model` wins, and is the escape
 * hatch for a name nothing recognises. Otherwise the runtimes are asked, and
 * exactly one claiming it settles it — `fable` is Claude Code's, `gpt-5.6-sol`
 * is Codex's, and an operator should not have to say so twice. Failing both,
 * the configured default.
 *
 * Deliberately one field rather than a runtime map beside a model map: those
 * two drift, and the pairing they encode is a single decision. It also means a
 * per-task override carries the runtime with it, so `m` can send one task to
 * Codex and leave the next on Claude.
 */
export function splitModel(cfg: Config, model: string | undefined): { name: string; model?: string } {
  const fallbackName = cfg.agent ?? 'claude';
  if (!model) return { name: fallbackName, model: undefined };
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    if (registry.has(prefix)) return { name: prefix, model: model.slice(slash + 1) || undefined };
  }
  const owners = [...registry.keys()].filter((n) => agentNamed(cfg, n).claims(model));
  // two runtimes claiming one name is an ambiguity the operator has to settle
  // with a prefix; picking one for them is how the wrong agent runs the work
  if (owners.length === 1) return { name: owners[0], model };
  return { name: fallbackName, model };
}

/**
 * Everything a session start needs: the runtime, its model, and the model it
 * may demote to.
 *
 * The fallback is dropped when it belongs to a different runtime. Demoting
 * across runtimes is not a thing a session can do, and passing a Codex model
 * to Claude Code as a fallback would fail only once the first one ran out.
 */
export function runtimeFor(cfg: Config, scope: ModelScope = 'general', override?: string): SessionRuntime {
  const chosen = override ?? modelFor(cfg.model ?? {}, scope);
  const { name, model } = splitModel(cfg, chosen);
  const rawFallback = modelFor(cfg.fallbackModel ?? {}, scope);
  const fallback = splitModel(cfg, rawFallback);
  return {
    backend: agentNamed(cfg, name),
    model,
    fallbackModel: rawFallback && fallback.name === name ? fallback.model : undefined,
  };
}

/**
 * The runtime with this name, for a conversation that already has one.
 *
 * Attaching is the case: a session was written by whichever runtime ran that
 * kind of work, and handing it to a different one's CLI would fail in a way
 * that looks like a broken session rather than a mismatch.
 */
export function agentNamed(cfg: Config, name: string): AgentBackend {
  let byName = cache.get(cfg);
  if (!byName) {
    byName = new Map();
    cache.set(cfg, byName);
  }
  const existing = byName.get(name);
  if (existing) return existing;
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown agent runtime "${name}" — known: ${knownAgents().join(', ') || 'none'}`);
  }
  const backend = factory(cfg);
  byName.set(name, backend);
  return backend;
}
