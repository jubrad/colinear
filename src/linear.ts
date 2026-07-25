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
  state { name }
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
  state: { name: string };
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
