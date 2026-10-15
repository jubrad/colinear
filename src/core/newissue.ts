import { modelsFor } from './models.js';
import { runtimeFor } from './agent.js';
import { providerFor } from './provider.js';
import type { Config, Scope } from './types.js';

/**
 * What the drafting agent answers. `team` is only asked for when the operator
 * left it to the agent, and then only as one of the keys it was given —
 * an enum, so a made-up team cannot even be expressed.
 */
export function issueSchema(teams?: Scope[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'number' },
      ...(teams ? { team: { type: 'string', enum: teams.map((t) => t.key) } } : {}),
    },
    required: ['title', 'description', ...(teams ? ['team'] : [])],
    additionalProperties: false,
  };
}

export interface IssueRequest {
  /** absent: the agent picks the team from the tracker's list */
  scopeId?: string;
  request: string;
  /** set in the form (0 none, 1 urgent … 4 low); absent lets the agent judge */
  priority?: number;
}

/** What the drafting agent is asked: the request, plus a priority and a team only when they are its to set. */
export function draftPrompt(request: string, priority: number | undefined, choosing: Scope[] | undefined): string {

  return `Draft a Linear issue from this request by the user:

"${request}"

You are in the team's primary repository — you may briefly inspect it (read-only) to use accurate component/file/service names, but keep it quick.

Produce:
- title: concise and actionable
- description: markdown with context, scope, and acceptance criteria — written for a reader who has NOT seen this conversation
${
  priority === undefined
    ? '- priority (optional): 1 urgent, 2 high, 3 medium, 4 low — omit unless the request implies one'
    : '- priority: omit it — the user has already set one'
}${
  choosing
    ? `
- team: the key of the team this belongs to, one of:
${choosing.map((t) => `  - ${t.key}${t.name && t.name !== t.key ? ` — ${t.name}` : ''}`).join('\n')}
  Pick by what the work is about. If nothing fits clearly, pick the closest rather than refusing.`
    : ''
}`;
}

/**
 * The team the agent named, as a scope — or a refusal. The schema's enum makes
 * a made-up key impossible where the runtime enforces structured output; one
 * that does not could still say anything, and filing into a guess is worse
 * than saying so.
 */
export function resolveTeam(choosing: Scope[], named: string | undefined): Scope {
  const chosen = choosing.find((t) => t.key === named);
  if (!chosen) throw new Error(`the agent picked "${named ?? 'no team'}", which is not one of your teams`);
  return chosen;
}

/** One-off agent pass: turn a rough request into a well-formed issue, and file it. */
export async function createIssueFromPrompt(
  cfg: Config,
  ask: IssueRequest,
  onActivity: (line: string) => void = () => {},
  onAgent?: (id: string) => void,
): Promise<{ id: string; identifier: string; team?: string }> {
  const provider = providerFor(cfg);
  const priority = ask.priority !== undefined && ask.priority >= 0 && ask.priority <= 4 ? ask.priority : undefined;
  // auto: the agent chooses among the teams, which it is shown by key and name
  const teams = ask.scopeId ? undefined : await provider.scopes();
  if (teams && !teams.length) throw new Error('the tracker has no teams to file into');
  const pick = teams && teams.length === 1 ? teams[0] : undefined;
  const choosing = teams && !pick ? teams : undefined;

  const result = await runtimeFor(cfg, 'draft-issue').backend.runSession({
    permissions: { mode: cfg.agentPermissionMode, deny: cfg.denyTools },
    agent: { kind: 'draft-issue', label: ask.request.slice(0, 60), origin: 'you pressed n in :issues', onRegistered: onAgent },
    prompt: draftPrompt(ask.request, priority, choosing),

    cwd: cfg.repos[0].path,
    callbacks: { onActivity, onSessionId: () => {}, onQuestion: (q) => q.answer(q.questions.map(() => 'use your best judgment')) },
    outputSchema: issueSchema(choosing),
    ...modelsFor(cfg, 'draft-issue'),
    maxTurns: 12,
  });
  if (result.isError) throw new Error(result.errors.join('; ') || 'draft session failed');
  const draft = result.structured as { title: string; description: string; priority?: number; team?: string };

  let scopeId = ask.scopeId ?? pick?.id;
  let team = pick?.key;
  if (choosing) {
    const chosen = resolveTeam(choosing, draft.team);
    scopeId = chosen.id;
    team = chosen.key;
  }
  const { team: _team, ...fields } = draft;
  const created = await provider.create({
    scopeId: scopeId!,
    ...fields,
    // the form's answer wins over the agent's guess; 0 means "none", said on purpose
    ...(priority !== undefined ? { priority } : {}),
  });
  return { ...created, team };
}
