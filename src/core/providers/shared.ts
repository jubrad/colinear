import type { Issue, StateType } from '../types.js';

/**
 * Helpers every adapter needs, in a leaf module on purpose: adapters import
 * these, and provider.ts imports the adapters, so nothing has to be registered
 * by import side-effect and there is no cycle to get wrong.
 */

/** Browse everything, k9s "all namespaces" style. */
export const ALL_SCOPES = '*';

/** Fallback branch name: lowercase identifier, nothing a git ref would reject. */
export function safeBranch(issue: Issue): string {
  const slug = issue.identifier
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `issue-${issue.id.slice(0, 8)}`;
}

/** Normalize whatever a tracker calls a state into the buckets colinear uses. */
export function stateTypeOf(raw: string | undefined): StateType | undefined {
  if (!raw) return undefined;
  const known: StateType[] = ['backlog', 'unstarted', 'started', 'completed', 'canceled', 'triage'];
  return known.includes(raw as StateType) ? (raw as StateType) : undefined;
}
