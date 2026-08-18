import { linearProvider } from './providers/linear.js';
import { sqliteProvider } from './providers/sqlite.js';
import { ALL_SCOPES, safeBranch, stateTypeOf } from './providers/shared.js';
import type { Config, Issue, Project, Scope, WorkflowState } from './types.js';

export { ALL_SCOPES, safeBranch, stateTypeOf };

/**
 * What an issue tracker can do. Colinear asks rather than assumes, because the
 * trackers genuinely differ: GitHub Issues has no priority, no "blocks"
 * relation and only open/closed, so a feature built on any of those has to
 * degrade rather than break.
 *
 * A capability that is false doesn't mean "call it and get an error" — the
 * feature that depends on it is switched off, and says so where the operator
 * would look for it.
 */
export interface ProviderCapabilities {
  /** "blocks" relations between issues → the blocked column, `f` force-start */
  blockers: boolean;
  /** parent/child issues → tracking parents, split plans, coordinators */
  subIssues: boolean;
  /** a priority field worth sorting on */
  priority: boolean;
  /** projects (or epics) → :projects, :project, project channels */
  projects: boolean;
  /** projects can be created from here → `n` in :projects */
  createProjects: boolean;
  /** a scope above the issue to browse by → the `t` picker, `--team` */
  scopes: boolean;
  /** issue states we can move through → stateSync */
  workflowStates: boolean;
  /** the tracker supplies a branch name (otherwise we derive one) */
  branchNames: boolean;
  /** comments we can post → escalation notes */
  comments: boolean;
}

export interface CreateIssueInput {
  scopeId: string;
  title: string;
  description?: string;
  projectId?: string;
  priority?: number;
  /** makes the new issue a child of this one */
  parentId?: string;
}

export interface CreateProjectInput {
  name: string;
  /** one line, for a list */
  description?: string;
  /** the brief itself, markdown */
  content?: string;
  /** the scopes it belongs to — a Linear project can span teams */
  scopeIds: string[];
  /** the tracker's own vocabulary: planned, started, paused … */
  state?: string;
  priority?: number;
  targetDate?: string;
}

export interface IssueFilter {
  scope?: string;
  labels?: string[];
  state?: string[];
  assignee?: 'me' | 'any';
  project?: string | null;
}

/**
 * The whole surface colinear needs from an issue tracker. Everything above
 * this line is provider-agnostic; everything below it is one adapter per
 * tracker.
 *
 * A provider instance closes over the config it was made from, so callers
 * don't thread credentials through the app.
 */
export interface IssueProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** what the UI calls a scope: "team" (Linear), "project" (Jira), "repo" */
  readonly scopeLabel: string;

  /** issues in a scope; undefined scope = mine, ALL_SCOPES = everywhere */
  issues(
    scope: string | undefined,
    opts?: { includeProjects?: boolean; includeSubIssues?: boolean },
  ): Promise<Issue[]>;
  filteredIssues(filter: IssueFilter): Promise<Issue[]>;
  issuesByIds(ids: string[]): Promise<Issue[]>;
  subIssues(parentId: string): Promise<Issue[]>;
  /** issues that must finish before this one — [] when unsupported */
  blockers(id: string): Promise<Array<{ id: string; identifier: string; done: boolean }>>;

  scopes(): Promise<Scope[]>;
  projects(): Promise<Project[]>;
  projectIssues(projectId: string): Promise<Issue[]>;

  create(input: CreateIssueInput): Promise<{ id: string; identifier: string }>;
  /** throws where capabilities.createProjects is false */
  createProject(input: CreateProjectInput): Promise<{ id: string; name: string; url?: string }>;
  blockIssue(blockerId: string, blockedId: string): Promise<void>;
  assign(issueId: string, userId: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;

  workflowStates(scopeId: string): Promise<WorkflowState[]>;
  setState(issueId: string, stateId: string): Promise<void>;

  viewer(): Promise<{ id: string; displayName: string }>;

  /**
   * A git branch for this issue. Providers that supply one return it; the rest
   * derive something safe — this is the only place that knows how.
   */
  branchFor(issue: Issue): string;
}

type Factory = (cfg: Config) => IssueProvider;

/**
 * Adapters are registered here, not by importing themselves somewhere — a
 * registration that depends on an import side-effect is one refactor away from
 * silently vanishing, and the failure ("unknown issue provider") looks nothing
 * like its cause.
 */
const registry = new Map<string, Factory>([
  ['linear', linearProvider],
  ['sqlite', sqliteProvider],
]);

export function registerProvider(name: string, factory: Factory): void {
  registry.set(name, factory);
}

const cache = new WeakMap<Config, IssueProvider>();

/**
 * The provider this config uses. Cached per config object — `reloadConfig`
 * mutates the same object in place, so a reload keeps the instance and its
 * settings both current.
 */
export function providerFor(cfg: Config): IssueProvider {
  const existing = cache.get(cfg);
  if (existing && existing.name === (cfg.provider ?? 'linear')) return existing;
  const name = cfg.provider ?? 'linear';
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`unknown issue provider "${name}" — known: ${[...registry.keys()].join(', ') || 'none'}`);
  }
  const provider = factory(cfg);
  cache.set(cfg, provider);
  return provider;
}
