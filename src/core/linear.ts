import type { Config, LinearIssue, LinearTeam } from './types.js';

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
  project { id }
  labels { nodes { name color } }
  assignee { id displayName }
  parent { id identifier }
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
  project?: { id: string } | null;
  labels: { nodes: Array<{ name: string; color: string }> };
  assignee?: { id: string; displayName: string } | null;
  parent?: { id: string; identifier: string } | null;
}

function toIssue(n: IssueNode): LinearIssue {
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    description: n.description,
    priority: n.priority,
    url: n.url,
    branchName: n.branchName,
    stateName: n.state.name,
    stateType: n.state.type,
    teamId: n.team?.id,
    projectId: n.project?.id,
    labels: n.labels.nodes,
    assignee: n.assignee?.displayName,
    assigneeId: n.assignee?.id,
    parent: n.parent ?? undefined,
  };
}

/** Direct sub-issues of a parent issue. */
export async function fetchSubIssues(cfg: Config, parentId: string): Promise<LinearIssue[]> {
  const data = await gql<{ issues: { nodes: IssueNode[] } }>(
    cfg,
    `query ($parentId: ID) {
      issues(first: 100, filter: { parent: { id: { eq: $parentId } } }) {
        nodes { ${ISSUE_FIELDS} }
      }
    }`,
    { parentId },
  );
  return data.issues.nodes.map(toIssue);
}

/** All-teams view sentinel (k9s-style "all namespaces"). */
export const ALL_TEAMS = '*';

/** teamKey: undefined = my assigned issues, ALL_TEAMS = every team, else that team's active issues. */
export async function fetchIssues(cfg: Config, teamKey?: string): Promise<LinearIssue[]> {
  if (teamKey) {
    const teamFilter = teamKey === ALL_TEAMS ? '' : 'team: { key: { eq: $team } }';
    const data = await gql<{ issues: { nodes: IssueNode[] } }>(
      cfg,
      `query TeamIssues${teamKey === ALL_TEAMS ? '' : '($team: String!)'} {
        issues(
          first: 100
          orderBy: updatedAt
          filter: {
            ${teamFilter}
            state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
            project: { null: true }
          }
        ) { nodes { ${ISSUE_FIELDS} } }
      }`,
      teamKey === ALL_TEAMS ? undefined : { team: teamKey },
    );
    return data.issues.nodes.map(toIssue);
  }
  const data = await gql<{ viewer: { assignedIssues: { nodes: IssueNode[] } } }>(
    cfg,
    `query MyIssues {
      viewer {
        assignedIssues(
          first: 50
          orderBy: updatedAt
          filter: {
            state: { type: { in: ["triage", "backlog", "unstarted", "started"] } }
            project: { null: true }
          }
        ) { nodes { ${ISSUE_FIELDS} } }
      }
    }`,
  );
  return data.viewer.assignedIssues.nodes.map(toIssue);
}

export async function fetchTeams(cfg: Config): Promise<LinearTeam[]> {
  const data = await gql<{ teams: { nodes: LinearTeam[] } }>(
    cfg,
    `query { teams(first: 100) { nodes { id key name } } }`,
  );
  return data.teams.nodes;
}

export interface IssueFilterSpec {
  team?: string;
  labels?: string[];
  /** workflow state types: triage, backlog, unstarted, started, completed */
  state?: string[];
  assignee?: 'me' | 'any';
  /** null = no project; a string matches the project name */
  project?: null | string;
}

/** Declarative filter (custom views) -> Linear IssueFilter object. */
export async function fetchFilteredIssues(cfg: Config, spec: IssueFilterSpec): Promise<LinearIssue[]> {
  const filter: Record<string, unknown> = {
    state: { type: { in: spec.state ?? ['triage', 'backlog', 'unstarted', 'started'] } },
  };
  if (spec.team) filter.team = { key: { eq: spec.team.toUpperCase() } };
  if (spec.labels?.length) filter.labels = { some: { name: { in: spec.labels } } };
  if (spec.assignee === 'me') filter.assignee = { isMe: { eq: true } };
  if (spec.project === null) filter.project = { null: true };
  else if (spec.project) filter.project = { name: { eqIgnoreCase: spec.project } };

  const data = await gql<{ issues: { nodes: IssueNode[] } }>(
    cfg,
    `query ($filter: IssueFilter) {
      issues(first: 100, orderBy: updatedAt, filter: $filter) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { filter },
  );
  return data.issues.nodes.map(toIssue);
}

export async function fetchProjects(cfg: Config): Promise<import('./types.js').LinearProject[]> {
  const data = await gql<{
    projects: {
      nodes: Array<{
        id: string;
        name: string;
        description?: string;
        state: string;
        progress: number;
        targetDate?: string;
        url: string;
        teams: { nodes: Array<{ id: string; key: string; name: string }> };
        lead?: { displayName: string } | null;
      }>;
    };
  }>(
    cfg,
    `query {
      projects(first: 75, filter: { state: { in: ["planned", "started", "paused"] } }) {
        nodes {
          id name description state progress targetDate url
          teams { nodes { id key name } }
          lead { displayName }
        }
      }
    }`,
  );
  return data.projects.nodes.map((n) => ({ ...n, teams: n.teams.nodes, lead: n.lead?.displayName }));
}

export async function fetchProjectIssues(cfg: Config, projectId: string): Promise<LinearIssue[]> {
  const data = await gql<{ issues: { nodes: IssueNode[] } }>(
    cfg,
    `query ($projectId: ID) {
      issues(
        first: 200
        filter: { project: { id: { eq: $projectId } } }
      ) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { projectId },
  );
  return data.issues.nodes.map(toIssue);
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

export async function fetchWorkflowStates(cfg: Config, teamId: string): Promise<import('./types.js').WorkflowState[]> {
  const data = await gql<{ team: { states: { nodes: import('./types.js').WorkflowState[] } } }>(
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

export async function fetchIssuesByIds(cfg: Config, ids: string[]): Promise<LinearIssue[]> {
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
