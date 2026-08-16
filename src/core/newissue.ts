import { runSession } from './agent.js';
import { createIssue } from './linear.js';
import type { Config } from './types.js';

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'number' },
  },
  required: ['title', 'description'],
  additionalProperties: false,
};

/** One-off agent pass: turn a rough request into a well-formed Linear issue. */
export async function createIssueFromPrompt(
  cfg: Config,
  teamId: string,
  request: string,
): Promise<{ id: string; identifier: string }> {
  const result = await runSession({
    prompt: `Draft a Linear issue from this request by the user:

"${request}"

You are in the team's primary repository — you may briefly inspect it (read-only) to use accurate component/file/service names, but keep it quick.

Produce:
- title: concise and actionable
- description: markdown with context, scope, and acceptance criteria — written for a reader who has NOT seen this conversation
- priority (optional): 1 urgent, 2 high, 3 medium, 4 low — omit unless the request implies one`,
    cwd: cfg.repos[0].path,
    callbacks: { onActivity: () => {}, onSessionId: () => {}, onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment')) },
    outputSchema: ISSUE_SCHEMA,
    model: cfg.model,
    maxTurns: 12,
  });
  if (result.isError) throw new Error(result.errors.join('; ') || 'draft session failed');
  const draft = result.structured as { title: string; description: string; priority?: number };
  return createIssue(cfg, { teamId, ...draft });
}
