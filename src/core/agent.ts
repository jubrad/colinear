import { claudeBackend } from './agents/claude.js';
import type { AgentBackend } from './agents/shared.js';
import type { Config } from './types.js';

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

const registry = new Map<string, Factory>([['claude', claudeBackend]]);

/** Register a runtime. Exported for the checks, which drive fakes through the seam. */
export function registerAgent(name: string, factory: Factory): void {
  registry.set(name, factory);
}

export function knownAgents(): string[] {
  return [...registry.keys()];
}

const cache = new WeakMap<Config, AgentBackend>();

/**
 * The runtime this config uses. Cached per config object — `reloadConfig`
 * mutates the same object in place, so a reload keeps the instance and its
 * settings both current, exactly as `providerFor` does.
 */
export function agentFor(cfg: Config): AgentBackend {
  const name = cfg.agent ?? 'claude';
  const existing = cache.get(cfg);
  if (existing && existing.name === name) return existing;
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown agent runtime "${name}" — known: ${knownAgents().join(', ') || 'none'}`);
  }
  const backend = factory(cfg);
  cache.set(cfg, backend);
  return backend;
}
