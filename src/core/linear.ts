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
  };
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
      }>;
    };
  }>(
    cfg,
    `query {
      projects(first: 75, filter: { state: { in: ["planned", "started", "paused"] } }) {
        nodes {
          id name description state progress targetDate url
          teams { nodes { id key name } }
        }
      }
    }`,
  );
  return data.projects.nodes.map((n) => ({ ...n, teams: n.teams.nodes }));
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
  input: { teamId: string; title: string; description?: string; projectId?: string; priority?: number },
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
