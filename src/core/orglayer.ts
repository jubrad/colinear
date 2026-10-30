import { join } from 'node:path';
import type { ConfigLayers, ConfigSource } from './types.js';

/**
 * The org layer (design/multi-user/config.md): the `ColiOrg` spec, which the
 * operator renders into each user's namespace as `org.json`. Only the fields
 * the daemon reads are typed here; the rest (users, workspace classes, idle)
 * are the operator's and the gateway's.
 */
export interface OrgSpec {
  repos?: OrgRepo[];
  tracker?: { provider?: string };
  models?: { allow?: string[] };
  /** anything a user's config can hold, as the org's default */
  config?: Record<string, unknown>;
  locked?: string[];
  limits?: { concurrency?: number };
}

interface OrgRepo {
  name: string;
  url: string;
  defaultBranch?: string;
  description?: string;
  checks?: Array<{ name: string; cmd: string }>;
}

type Raw = Record<string, unknown>;

/**
 * Keys a user's file can't set when there's an org layer, and why. In a cluster
 * the daemon owns none of these: the operator only builds workspaces for repos
 * it knows, there's one tracker per install, and every session runs in a pod.
 */
const ORG_ONLY: Record<string, string> = {
  repos: 'the org lists the repos a cluster can build workspaces for',
  repo: 'the org lists the repos a cluster can build workspaces for',
  defaultBranch: 'the org lists the repos a cluster can build workspaces for',
  worktreeRoot: "workspaces aren't paths on the daemon's disk",
  checks: "the org sets each repo's checks",
  provider: 'one tracker per install: the org chooses it',
  runner: 'in a cluster every session runs in a workspace pod',
  linearApiKey: 'replaced by your Linear connection',
  remote: 'this daemon is already remote',
};

/** What the org's `config` mustn't hold: the spec has a proper field for it, or every user can read it. */
const NOT_IN_ORG_CONFIG: Record<string, string> = {
  repos: 'set spec.repos, not spec.config.repos',
  provider: 'set spec.tracker, not spec.config.provider',
  linearApiKey: 'every user can read the org config: a key never goes in it',
  remote: 'a remote is one person\'s machine',
};

/** Personal: an org default for these would be a guess about someone's terminal. */
const USER_ONLY = new Set(['editor', 'terminal', 'notifications']);

/** Loosest first. Headless, a mode that would ask is a mode that refuses. */
const STRICTNESS = ['bypassPermissions', 'auto', 'acceptEdits', 'default', 'dontAsk', 'plan'];

/** Always allowed whatever `models.allow` says: "Claude Code picks", and "off". */
const MODEL_ALIASES = new Set(['default', '']);

/**
 * Merge the org layer under the user's file, key by key, into the raw shape
 * `loadConfig` normalizes. Pure: no file is read, so every rule can be checked
 * on its own (`orglayer.check.ts`).
 *
 * Without an org this is the identity, plus where each key came from.
 *
 * `stateDir` places a repo the org listed: it has no checkout on the daemon's
 * disk, and a `RepoConfig` needs a path until the cluster provider (work order
 * 3.5) makes workspaces by repo name.
 */
export function mergeLayers(
  org: OrgSpec | undefined,
  user: Raw,
  stateDir: string,
): { raw: Raw; layers: ConfigLayers } {
  const sources: Record<string, ConfigSource> = {};
  if (!org) {
    for (const key of Object.keys(user)) sources[key] = 'you';
    return { raw: { ...user }, layers: { sources, locked: [], ignored: [] } };
  }

  const ignored: ConfigLayers['ignored'] = [];
  const locked = [...new Set(org.locked ?? [])];
  const orgConfig: Raw = { ...(org.config ?? {}) };
  for (const key of Object.keys(orgConfig)) {
    const reason = NOT_IN_ORG_CONFIG[key] ?? (USER_ONLY.has(key) ? "personal: only a user's own config sets it" : undefined);
    if (reason) {
      ignored.push({ key, from: 'org', reason });
      delete orgConfig[key];
    }
  }

  const raw: Raw = {};
  const set = (key: string, value: unknown, from: ConfigSource) => {
    if (value === undefined) return;
    raw[key] = value;
    sources[key] = from;
  };
  const refuse = (key: string, reason: string) => ignored.push({ key, from: 'you', reason });

  for (const key of new Set([...Object.keys(orgConfig), ...Object.keys(user)])) {
    const theirs = orgConfig[key];
    const mine = user[key];
    if (key in ORG_ONLY) {
      if (mine !== undefined) refuse(key, ORG_ONLY[key]);
      set(key, theirs, 'org');
    } else if (locked.includes(key)) {
      if (mine !== undefined && JSON.stringify(mine) !== JSON.stringify(theirs)) refuse(key, 'locked by the org');
      set(key, theirs, 'org');
    } else if (key === 'denyTools') {
      // a user can add rules and can't take the org's away
      const union = [...new Set([...list(theirs), ...list(mine)])];
      set(key, union, mine === undefined ? 'org' : theirs === undefined ? 'you' : 'both');
    } else if (key === 'guidance') {
      set(key, concatGuidance(theirs, mine), mine === undefined ? 'org' : theirs === undefined ? 'you' : 'both');
    } else if (key === 'model' || key === 'fallbackModel') {
      const allowed = withinAllow(key, mine, org.models?.allow, refuse);
      if (allowed === undefined) set(key, theirs, 'org');
      else if (theirs === undefined) set(key, allowed, 'you');
      // scope by scope: a user naming only their review model keeps the org's general one
      else set(key, { ...scopes(theirs), ...scopes(allowed) }, 'both');
    } else if (key === 'agentPermissionMode') {
      const floor = typeof theirs === 'string' ? theirs : undefined;
      if (typeof mine === 'string' && floor && STRICTNESS.indexOf(mine) < STRICTNESS.indexOf(floor)) {
        refuse(key, `looser than the org's "${floor}": you may only choose a stricter mode`);
        set(key, theirs, 'org');
      } else if (mine !== undefined) set(key, mine, 'you');
      else set(key, theirs, 'org');
    } else if (mine !== undefined) {
      set(key, mine, 'you');
    } else {
      set(key, theirs, 'org');
    }
  }

  // a lock on a key the org didn't set still holds: the default is the org's answer
  for (const key of locked) if (!(key in raw)) sources[key] = 'default';

  if (org.tracker?.provider) set('provider', org.tracker.provider, 'org');
  if (org.repos?.length) {
    set(
      'repos',
      org.repos.map((r) => ({
        name: r.name,
        description: r.description,
        path: join(stateDir, 'repos', r.name),
        defaultBranch: r.defaultBranch ?? 'main',
        url: r.url,
        ...(githubName(r.url) ? { github: githubName(r.url) } : {}),
        checks: r.checks ?? [],
      })),
      'org',
    );
  }

  const cap = org.limits?.concurrency;
  if (typeof cap === 'number' && cap >= 1) {
    const wanted = typeof raw.concurrency === 'number' ? raw.concurrency : undefined;
    if (wanted !== undefined && wanted > cap) {
      if (sources.concurrency === 'you') refuse('concurrency', `capped at ${cap} by the org's limits`);
      set('concurrency', cap, 'org');
    } else if (wanted === undefined) {
      // the built-in default may be over the cap too
      set('concurrency', Math.min(cap, DEFAULT_CONCURRENCY), 'org');
    }
  }

  return { raw, layers: { sources, locked, ignored } };
}

/** loadConfig's own default, so the cap can apply to it without a user setting anything */
export const DEFAULT_CONCURRENCY = 3;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** `model` is a string (for everything) or a map of scopes; as a map either way. */
function scopes(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { general: v };
  return v && typeof v === 'object' ? { ...(v as Raw) } : {};
}

/**
 * The user's model, minus anything the org doesn't allow. Scope by scope, so
 * one disallowed choice doesn't throw away the rest; a disallowed bare string
 * falls back to the org's whole answer.
 */
function withinAllow(
  key: string,
  mine: unknown,
  allow: string[] | undefined,
  refuse: (key: string, reason: string) => void,
): unknown {
  if (mine === undefined || !allow?.length) return mine;
  const ok = (m: unknown) => typeof m === 'string' && (MODEL_ALIASES.has(m.trim()) || allow.includes(m.trim()));
  const why = `the org allows ${allow.join(', ')}`;
  if (typeof mine === 'string') {
    if (ok(mine)) return mine;
    refuse(key, `"${mine}" isn't allowed: ${why}`);
    return undefined;
  }
  const kept: Raw = {};
  for (const [scope, m] of Object.entries(scopes(mine))) {
    if (ok(m)) kept[scope] = m;
    else refuse(`${key}.${scope}`, `"${String(m)}" isn't allowed: ${why}`);
  }
  return Object.keys(kept).length ? kept : undefined;
}

/** Guidance as a scope map of text, whichever of its three shapes it was written in. */
function guidanceScopes(v: unknown): Record<string, string> {
  const text = (t: unknown) => (Array.isArray(t) ? t.join('\n') : typeof t === 'string' ? t : undefined);
  if (typeof v === 'string' || Array.isArray(v)) return { general: text(v)! };
  const out: Record<string, string> = {};
  if (v && typeof v === 'object') {
    for (const [scope, t] of Object.entries(v as Raw)) {
      const s = text(t);
      if (s?.trim()) out[scope] = s;
    }
  }
  return out;
}

/** The org's guidance first, then the user's, scope by scope. */
function concatGuidance(theirs: unknown, mine: unknown): Record<string, string> {
  const org = guidanceScopes(theirs);
  const you = guidanceScopes(mine);
  const out: Record<string, string> = {};
  for (const scope of new Set([...Object.keys(org), ...Object.keys(you)])) {
    out[scope] = [org[scope], you[scope]].filter((t) => t?.trim()).join('\n\n');
  }
  return out;
}

/** owner/name for a github.com URL, https or ssh; nothing for anything else. */
export function githubName(url: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}
