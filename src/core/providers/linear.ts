import type { IssueProvider } from '../provider.js';
import { safeBranch, stateTypeOf } from './shared.js';
import type { Project, Config, Issue, Scope } from '../types.js';

const API = 'https://api.linear.app/graphql';

async function gql<T>(cfg: Config, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: cfg.linearApiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(`Linear GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new Error('Linear GraphQL: empty response');
  return body.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  url
  branchName
  state { name type }
  team { id }
  project { id name }
  labels { nodes { name color } }
  assignee { id displayName }
  parent { id identifier }
  projectMilestone { name }
`;

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  branchName: string;
  state: { name: string; type: string };
  team?: { id: string } | null;
  project?: { id: string; name?: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  assignee?: { id: string; displayName: string } | null;
  parent?: { id: string; identifier: string } | null;
  projectMilestone?: { name: string } | null;
}

function toIssue(n: IssueNode): Issue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    priority: n.priority,
    url: n.url,
    branchName: n.branchName,
    stateName: n.state.name,
    stateType: stateTypeOf(n.state.type),
    teamId: n.team?.id,
    projectId: n.project?.id,
    projectName: n.project?.name,
    milestoneName: n.projectMilestone?.name,
    labels: n.labels.nodes,
    assignee: n.assignee?.displayName,
    assigneeId: n.assignee?.id,
    parent: n.parent ?? undefined,
  };
}

/** Hard cap across pages so a runaway filter can't pull the whole workspace. */
const MAX_ISSUES = 500;

/** Cursor-paginated issue query — Linear caps pages at 100 nodes. */
async function queryIssuesPaged(cfg: Config, filter: Record<string, unknown>): Promise<Issue[]> {
  const out: IssueNode[] = [];
  let after: string | undefined;
  do {
    const data = await gql<{
      issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
    }>(
      cfg,
      `query ($filter: IssueFilter, $after: String) {
        issues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after },
    );
    out.push(...data.issues.nodes);
    after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : undefined;
  } while (after && out.length < MAX_ISSUES);
  return out.map(toIssue);
}

/** Direct sub-issues of a parent issue. */
export async function fetchSubIssues(cfg: Config, parentId: string): Promise<Issue[]> {
  return queryIssuesPaged(cfg, { parent: { id: { eq: parentId } } });
}

/** All-teams view sentinel (k9s-style "all namespaces"). */
export const ALL_TEAMS = '*';

/** teamKey: undefined = my assigned issues, ALL_TEAMS = every team, else that team's active issues. */
export async function fetchIssues(
  cfg: Config,
  teamKey?: string,
  opts?: { includeProjects?: boolean; includeSubIssues?: boolean },
): Promise<Issue[]> {
  const open = { state: { type: { in: ['triage', 'backlog', 'unstarted', 'started'] } } };
  const filter: Record<string, unknown> = { ...open };
  if (!opts?.includeProjects) filter.project = { null: true };
  if (teamKey === undefined) filter.assignee = { isMe: { eq: true } };
  else if (teamKey !== ALL_TEAMS) filter.team = { key: { eq: teamKey } };
  const top = await queryIssuesPaged(cfg, filter);
  if (!opts?.includeSubIssues) return top;

  // Sub-issues are usually invisible here for reasons that have nothing to do
  // with being sub-issues: they inherit the parent's project (excluded unless
  // `p`) or belong to whoever picked them up (excluded in the "mine" view). So
  // this asks for them by parent instead of relaxing the filters, which would
  // change what the list means.
  const parents = top.map((i) => i.id).slice(0, CHILD_PARENT_CAP);
  if (!parents.length) return top;
  const children = await queryIssuesPaged(cfg, { ...open, parent: { id: { in: parents } } });
  const seen = new Set(top.map((i) => i.id));
  return [...top, ...children.filter((c) => !seen.has(c.id))];
}

/** One extra query, not one per row — but a filter has a size, so it is capped. */
const CHILD_PARENT_CAP = 200;

export async function fetchTeams(cfg: Config): Promise<Scope[]> {
  const data = await gql<{ teams: { nodes: Scope[] } }>(
    cfg,
    `query { teams(first: 100) { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

interface IssueFilterSpec {
  team?: string;
  labels?: string[];
  /** workflow state types: triage, backlog, unstarted, started, completed */
  state?: string[];
  assignee?: 'me' | 'any';
  /** null = no project; a string matches the project name */
  project?: null | string;
}

/** Declarative filter (custom views) -> Linear IssueFilter object. */
export async function fetchFilteredIssues(cfg: Config, spec: IssueFilterSpec): Promise<Issue[]> {
  const filter: Record<string, unknown> = {
    state: { type: { in: spec.state ?? ['triage', 'backlog', 'unstarted', 'started'] } },
  };
  if (spec.team) filter.team = { key: { eq: spec.team.toUpperCase() } };
  if (spec.labels?.length) filter.labels = { some: { name: { in: spec.labels } } };
  if (spec.assignee === 'me') filter.assignee = { isMe: { eq: true } };
  if (spec.project === null) filter.project = { null: true };
  else if (spec.project) filter.project = { name: { eqIgnoreCase: spec.project } };

  return queryIssuesPaged(cfg, filter);
}

type ProjectNode = {
  id: string;
  name: string;
  description?: string;
  state: string;
  priority?: number;
  progress: number;
  targetDate?: string;
  url: string;
  teams: { nodes: Array<{ id: string; key: string; name: string }> };
  lead?: { displayName: string } | null;
};

async function fetchProjectsPage(
  cfg: Config,
  after: string | undefined,
): Promise<{ nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } }> {
  const data = await gql<{
    projects: { nodes: ProjectNode[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
  }>(
    cfg,
    // backlog belongs in the list: a project that exists but isn't scheduled
    // yet is exactly the one you'd open to plan. Only settled states stay out.
    `query ($after: String) {
      projects(
        first: 100
        after: $after
        filter: { state: { nin: ["completed", "canceled"] } }
      ) {
        nodes {
          id name description state priority progress targetDate url
          teams { nodes { id key name } }
          lead { displayName }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { after },
  );
  return data.projects;
}

/** A workspace can hold more projects than one page; a fixed 75 silently hid the rest. */
const MAX_PROJECTS = 400;

export async function fetchProjects(cfg: Config): Promise<Project[]> {
  const nodes = [];
  let after: string | undefined;
  do {
    const page = await fetchProjectsPage(cfg, after);
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (after && nodes.length < MAX_PROJECTS);
  return nodes.map((n) => ({ ...n, scopes: n.teams.nodes, lead: n.lead?.displayName }));
}

export async function fetchProjectIssues(cfg: Config, projectId: string): Promise<Issue[]> {
  return queryIssuesPaged(cfg, { project: { id: { eq: projectId } } });
}

/**
 * Create a project. Linear takes the brief as `content` (markdown) and the one
 * line the project list shows as `description`, so both are sent rather than
 * one being duplicated into the other.
 */
export async function createProject(
  cfg: Config,
  input: {
    name: string;
    description?: string;
    content?: string;
    scopeIds: string[];
    state?: string;
    priority?: number;
    targetDate?: string;
  },
): Promise<{ id: string; name: string; url?: string }> {
  const data = await gql<{
    projectCreate: { success: boolean; project?: { id: string; name: string; url: string } };
  }>(
    cfg,
    `mutation ($input: ProjectCreateInput!) {
      projectCreate(input: $input) { success project { id name url } }
    }`,
    {
      input: {
        name: input.name,
        teamIds: input.scopeIds,
        ...(input.description ? { description: input.description } : {}),
        ...(input.content ? { content: input.content } : {}),
        ...(input.state ? { state: input.state } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.targetDate ? { targetDate: input.targetDate } : {}),
      },
    },
  );
  if (!data.projectCreate.success || !data.projectCreate.project) {
    throw new Error('Linear refused the project');
  }
  return data.projectCreate.project;
}

/**
 * A project's documents. Linear's Document carries markdown in `content`;
 * `updatedAt` is the conflict token publish compares before overwriting.
 */
export async function fetchProjectDocuments(
  cfg: Config,
  projectId: string,
): Promise<Array<{ id: string; title: string; content: string; updatedAt: string; url?: string }>> {
  const data = await gql<{
    project: {
      documents: { nodes: Array<{ id: string; title: string; content?: string; updatedAt: string; url: string }> };
    };
  }>(
    cfg,
    `query ($id: String!) {
      project(id: $id) {
        documents(first: 25) { nodes { id title content updatedAt url } }
      }
    }`,
    { id: projectId },
  );
  return (data.project?.documents.nodes ?? [])
    .map((n) => ({ ...n, content: n.content ?? '' }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveProjectDocument(
  cfg: Config,
  projectId: string,
  doc: { id?: string; title: string; content: string },
): Promise<{ id: string; updatedAt: string; url?: string }> {
  if (doc.id) {
    const data = await gql<{
      documentUpdate: { success: boolean; document?: { id: string; updatedAt: string; url: string } };
    }>(
      cfg,
      `mutation ($id: String!, $input: DocumentUpdateInput!) {
        documentUpdate(id: $id, input: $input) { success document { id updatedAt url } }
      }`,
      { id: doc.id, input: { title: doc.title, content: doc.content } },
    );
    if (!data.documentUpdate.success || !data.documentUpdate.document) throw new Error('Linear refused the document update');
    return data.documentUpdate.document;
  }
  const data = await gql<{
    documentCreate: { success: boolean; document?: { id: string; updatedAt: string; url: string } };
  }>(
    cfg,
    `mutation ($input: DocumentCreateInput!) {
      documentCreate(input: $input) { success document { id updatedAt url } }
    }`,
    { input: { title: doc.title, content: doc.content, projectId } },
  );
  if (!data.documentCreate.success || !data.documentCreate.document) throw new Error('Linear refused the document');
  return data.documentCreate.document;
}

export async function createIssue(
  cfg: Config,
  input: {
    teamId: string;
    title: string;
    description?: string;
    projectId?: string;
    priority?: number;
    /** makes the new issue a sub-issue of this parent */
    parentId?: string;
    /** Linear's name for the milestone field on IssueCreateInput */
    projectMilestoneId?: string;
  },
): Promise<{ id: string; identifier: string }> {
  const data = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(
    cfg,
    `mutation ($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier } }
    }`,
    { input },
  );
  if (!data.issueCreate.success) throw new Error('issueCreate failed');
  return data.issueCreate.issue;
}

export async function fetchProjectMilestones(
  cfg: Config,
  projectId: string,
): Promise<import('../provider.js').ProjectMilestone[]> {
  const data = await gql<{
    project: { projectMilestones: { nodes: Array<{ id: string; name: string; targetDate?: string; description?: string }> } };
  }>(
    cfg,
    `query ($id: String!) {
      project(id: $id) {
        projectMilestones(first: 100) { nodes { id name targetDate description } }
      }
    }`,
    { id: projectId },
  );
  return data.project.projectMilestones.nodes.map((m) => ({
    id: m.id,
    name: m.name,
    targetDate: m.targetDate ?? undefined,
    description: m.description ?? undefined,
  }));
}

export async function createProjectMilestone(
  cfg: Config,
  projectId: string,
  milestone: { name: string; targetDate?: string; description?: string },
): Promise<{ id: string; name: string }> {
  const data = await gql<{
    projectMilestoneCreate: { success: boolean; projectMilestone: { id: string; name: string } };
  }>(
    cfg,
    `mutation ($input: ProjectMilestoneCreateInput!) {
      projectMilestoneCreate(input: $input) { success projectMilestone { id name } }
    }`,
    { input: { projectId, ...milestone } },
  );
  if (!data.projectMilestoneCreate.success) throw new Error('projectMilestoneCreate failed');
  return data.projectMilestoneCreate.projectMilestone;
}

export async function postProjectUpdate(
  cfg: Config,
  projectId: string,
  body: string,
): Promise<{ id: string; url?: string }> {
  const data = await gql<{
    projectUpdateCreate: { success: boolean; projectUpdate: { id: string; url?: string } };
  }>(
    cfg,
    `mutation ($input: ProjectUpdateCreateInput!) {
      projectUpdateCreate(input: $input) { success projectUpdate { id url } }
    }`,
    { input: { projectId, body } },
  );
  if (!data.projectUpdateCreate.success) throw new Error('projectUpdateCreate failed');
  return data.projectUpdateCreate.projectUpdate;
}

export async function fetchWorkflowStates(cfg: Config, teamId: string): Promise<import('../types.js').WorkflowState[]> {
  const data = await gql<{ team: { states: { nodes: import('../types.js').WorkflowState[] } } }>(
    cfg,
    `query ($teamId: String!) {
      team(id: $teamId) { states { nodes { id name type position } } }
    }`,
    { teamId },
  );
  return data.team.states.nodes;
}

export async function updateIssueState(cfg: Config, issueId: string, stateId: string): Promise<void> {
  await gql(
    cfg,
    `mutation ($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) { success }
    }`,
    { issueId, stateId },
  );
}

/** blocker "blocks" blocked — a Linear blocking relation */
export async function createBlocksRelation(cfg: Config, blockerId: string, blockedId: string): Promise<void> {
  await gql(
    cfg,
    `mutation ($input: IssueRelationCreateInput!) {
      issueRelationCreate(input: $input) { success }
    }`,
    { input: { issueId: blockerId, relatedIssueId: blockedId, type: 'blocks' } },
  );
}

export async function fetchIssuesByIds(cfg: Config, ids: string[]): Promise<Issue[]> {
  if (!ids.length) return [];
  const data = await gql<{ issues: { nodes: IssueNode[] } }>(
    cfg,
    `query ($ids: [ID!]) {
      issues(first: 50, filter: { id: { in: $ids } }) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { ids },
  );
  return data.issues.nodes.map(toIssue);
}

/** Unresolved issues that block this one (Linear "blocks" relations, both directions). */
export async function fetchBlockers(
  cfg: Config,
  issueId: string,
): Promise<Array<{ id: string; identifier: string; done: boolean }>> {
  const data = await gql<{
    issue: {
      relations: { nodes: Array<{ type: string; relatedIssue?: RelNode | null }> };
      inverseRelations: { nodes: Array<{ type: string; issue?: RelNode | null }> };
    };
  }>(
    cfg,
    `query ($id: String!) {
      issue(id: $id) {
        relations(first: 50) { nodes { type relatedIssue { id identifier state { type } } } }
        inverseRelations(first: 50) { nodes { type issue { id identifier state { type } } } }
      }
    }`,
    { id: issueId },
  );
  // inverseRelations of type "blocks": other issue blocks this one
  const blockers = data.issue.inverseRelations.nodes
    .filter((n) => n.type === 'blocks' && n.issue)
    .map((n) => n.issue!);
  return blockers.map((b) => ({
    id: b.id,
    identifier: b.identifier,
    done: b.state.type === 'completed' || b.state.type === 'canceled',
  }));
}

interface RelNode {
  id: string;
  identifier: string;
  state: { type: string };
}

export async function fetchViewer(cfg: Config): Promise<{ id: string; displayName: string }> {
  const data = await gql<{ viewer: { id: string; displayName: string } }>(
    cfg,
    `query { viewer { id displayName } }`,
  );
  return data.viewer;
}

export async function assignIssue(cfg: Config, issueId: string, userId: string): Promise<void> {
  await gql(
    cfg,
    `mutation ($issueId: String!, $userId: String!) {
      issueUpdate(id: $issueId, input: { assigneeId: $userId }) { success }
    }`,
    { issueId, userId },
  );
}

export async function postComment(cfg: Config, issueId: string, body: string): Promise<void> {
  await gql(
    cfg,
    `mutation ($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }`,
    { issueId, body },
  );
}


/**
 * Linear as an IssueProvider. It supports everything colinear knows how to
 * ask for — which is not a coincidence: the feature set was built against it,
 * and the capability flags exist so the next tracker can say no.
 */
export function linearProvider(cfg: Config): IssueProvider {
  return {
    name: 'linear',
    scopeLabel: 'team',
    capabilities: {
      blockers: true,
      subIssues: true,
      priority: true,
      projects: true,
      createProjects: true,
      documents: true,
      milestones: true,
      projectUpdates: true,
      scopes: true,
      workflowStates: true,
      branchNames: true,
      comments: true,
    },
    issues: (scope, opts) => fetchIssues(cfg, scope, opts),
    // IssueFilter says scope; the spec says team — passing the object through
    // unchanged silently dropped the scope, which is the kind of miss that
    // turns a team-confined sweep into a workspace-wide one
    filteredIssues: (filter) => fetchFilteredIssues(cfg, { ...filter, team: filter.scope }),
    issuesByIds: (ids) => fetchIssuesByIds(cfg, ids),
    subIssues: (parentId) => fetchSubIssues(cfg, parentId),
    blockers: (id) => fetchBlockers(cfg, id),
    scopes: () => fetchTeams(cfg),
    projects: () => fetchProjects(cfg),
    projectIssues: (projectId) => fetchProjectIssues(cfg, projectId),
    createProject: (input) => createProject(cfg, input),
    projectDocuments: (projectId) => fetchProjectDocuments(cfg, projectId),
    saveProjectDocument: (projectId, doc) => saveProjectDocument(cfg, projectId, doc),
    create: ({ scopeId, title, description, projectId, priority, parentId, milestoneId }) =>
      createIssue(cfg, { teamId: scopeId, title, description, projectId, priority, parentId, projectMilestoneId: milestoneId }),
    projectMilestones: (projectId) => fetchProjectMilestones(cfg, projectId),
    createMilestone: (projectId, milestone) => createProjectMilestone(cfg, projectId, milestone),
    postProjectUpdate: (projectId, body) => postProjectUpdate(cfg, projectId, body),
    blockIssue: (blockerId, blockedId) => createBlocksRelation(cfg, blockerId, blockedId),
    assign: (issueId, userId) => assignIssue(cfg, issueId, userId),
    comment: (issueId, body) => postComment(cfg, issueId, body),
    workflowStates: (scopeId) => fetchWorkflowStates(cfg, scopeId),
    setState: (issueId, stateId) => updateIssueState(cfg, issueId, stateId),
    viewer: () => fetchViewer(cfg),
    // Linear hands us a branch name per issue; only fall back if it didn't
    branchFor: (issue) => issue.branchName || safeBranch(issue),
  };
}
