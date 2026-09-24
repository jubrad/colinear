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
  return agentNamed(cfg, modelFor(cfg.agent ?? {}, scope) ?? 'claude');
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
