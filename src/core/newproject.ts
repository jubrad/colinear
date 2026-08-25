import { runSession } from './agent.js';
import { isDemo } from './demo.js';
import { providerFor } from './provider.js';
import type { Config } from './types.js';

const PROJECT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['name', 'description', 'content'],
  additionalProperties: false,
};

export interface ProjectBrief {
  /** the scope(s) it belongs to */
  scopeIds: string[];
  /** what the operator typed */
  request: string;
  state?: string;
  priority?: number;
  targetDate?: string;
}

/**
 * One-off agent pass: a rough brief becomes a project with a name a stranger
 * can read, a one-line summary for the list, and a body worth opening.
 *
 * Same shape as `createIssueFromPrompt` and for the same reason — the operator
 * knows what they want and shouldn't have to write the framing.
 */
export async function createProjectFromPrompt(
  cfg: Config,
  brief: ProjectBrief,
  onActivity: (line: string) => void = () => {},
  onAgent?: (id: string) => void,
): Promise<{ id: string; name: string; url?: string }> {
  const provider = providerFor(cfg);
  if (!provider.capabilities.createProjects) {
    throw new Error(`${provider.name} cannot create projects`);
  }
  const draft = isDemo(cfg) ? demoDraft(brief.request) : await draftWithAgent(cfg, brief, onActivity, onAgent);
  return provider.createProject({
    ...draft,
    scopeIds: brief.scopeIds,
    state: brief.state,
    priority: brief.priority,
    targetDate: brief.targetDate,
  });
}

async function draftWithAgent(
  cfg: Config,
  brief: ProjectBrief,
  onActivity: (line: string) => void,
  onAgent?: (id: string) => void,
): Promise<{ name: string; description: string; content: string }> {
  const result = await runSession({
    permissions: { mode: cfg.agentPermissionMode, deny: cfg.denyTools },
    agent: { kind: 'draft-project', label: brief.request.slice(0, 60), origin: 'you pressed n in :projects', onRegistered: onAgent },
    prompt: `Draft a project from this brief by the user:

"${brief.request}"

You are in the team's primary repository — you may briefly inspect it (read-only) to use accurate component, service and file names, but keep it quick.

Produce:
- name: what this project is, in a few words. No dates, no "Q3", no ticket numbers
- description: one line for a project list — what changes for users when this lands
- content: markdown. The problem, what is in scope, what is explicitly not, and how anyone will know it worked. Write for someone who has NOT seen this brief. Do not invent a schedule, owners, or issue breakdowns — issues get filed separately.`,
    cwd: cfg.repos[0].path,
    callbacks: {
      onActivity,
      onSessionId: () => {},
      onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment')),
    },
    outputSchema: PROJECT_SCHEMA,
    model: cfg.model,
    maxTurns: 12,
  });
  if (result.isError) throw new Error(result.errors.join('; ') || 'draft session failed');
  return result.structured as { name: string; description: string; content: string };
}

/**
 * Demo mode runs no agents, so the brief is shaped locally rather than being
 * sent nowhere: the first line becomes the name, the rest the body. It reads as
 * a plainer version of the same thing, which is the honest thing to show.
 */
function demoDraft(request: string): { name: string; description: string; content: string } {
  const [first = 'New project', ...rest] = request.trim().split('\n');
  const name = first.replace(/[.!?]+$/, '').slice(0, 60);
  return {
    name,
    description: (rest.find((l) => l.trim()) ?? first).trim().slice(0, 140),
    content: `${request.trim()}\n\n_Drafted in demo mode — no agent ran._\n`,
  };
}
