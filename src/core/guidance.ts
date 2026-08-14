import type { Guidance, GuidanceScope } from './types.js';

/**
 * Operator's standing guidance for one kind of work: the general block plus
 * whatever is scoped to this prompt. Scoped text adds to `general` rather
 * than replacing it, so house rules only need saying once.
 */
export function guidanceFor(guidance: Guidance, scope: GuidanceScope): string {
  const parts = [guidance.general, guidance[scope]].map((t) => t?.trim()).filter(Boolean);
  return parts.length ? `\n## Standing guidance from the operator\n${parts.join('\n\n')}` : '';
}
