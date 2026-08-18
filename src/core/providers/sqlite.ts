import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { STATE_DIR } from '../log.js';
import type { CreateIssueInput, IssueFilter, IssueProvider } from '../provider.js';
import type { Config, Issue, Project, Scope, StateType, WorkflowState } from '../types.js';
import { safeBranch } from './shared.js';

/**
 * A local issue tracker in a sqlite file.
 *
 * It exists for three reasons: you can try colinear without an account, the
 * demo/CI board needs somewhere real to live, and it is the second
 * implementation that proves the provider interface is an interface rather
 * than a description of Linear. Everything is supported — sub-issues, blocking
 * relations, projects, states, priorities, comments — because there is no
 * upstream to say no.
 *
 * `node:sqlite` is required lazily, on purpose: it needs Node 24 (or 22 with
 * --experimental-sqlite), and a static import would break Node 20 for people
 * who only ever use Linear.
 */

interface Row {
  [column: string]: string | number | null;
}

interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | undefined;
    run(...params: unknown[]): { changes: number };
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS states (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, state TEXT DEFAULT 'started',
  progress REAL DEFAULT 0, target_date TEXT, lead TEXT, priority INTEGER DEFAULT 0, content TEXT
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  state_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  project_id TEXT,
  parent_id TEXT,
  assignee_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS issue_labels (issue_id TEXT NOT NULL, label_id TEXT NOT NULL);
/* "blocker must land before blocked" — the relation colinear parks tasks on */
CREATE TABLE IF NOT EXISTS blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL,
  author TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
`;

/** A tracker with no states can't express "in progress"; seed the usual ladder. */
const DEFAULT_STATES: Array<[string, StateType, number]> = [
  ['Backlog', 'backlog', 0],
  ['Todo', 'unstarted', 1],
  ['In Progress', 'started', 2],
  ['In Review', 'started', 3],
  ['Done', 'completed', 4],
  ['Cancelled', 'canceled', 5],
];

const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function open(path: string): Db {
  const require = createRequire(import.meta.url);
  let DatabaseSync: new (path: string) => Db;
  try {
    ({ DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Db });
  } catch {
    throw new Error(
      'the sqlite provider needs node:sqlite — Node 24+, or Node 22 with --experimental-sqlite. ' +
        'Your Node is ' + process.version,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  // added after the first release: CREATE TABLE IF NOT EXISTS leaves an
  // existing table alone, so the column has to be asked for separately
  for (const column of ['priority INTEGER DEFAULT 0', 'content TEXT']) {
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${column}`);
    } catch {
      /* already there */
    }
  }
  seed(db);
  return db;
}

/** First open: one scope, the state ladder, and a viewer to assign things to. */
function seed(db: Db): void {
  const scope = db.prepare('SELECT id FROM scopes LIMIT 1').get();
  if (!scope) {
    const scopeId = id();
    db.prepare('INSERT INTO scopes (id, key, name) VALUES (?, ?, ?)').run(scopeId, 'LOC', 'Local');
    for (const [name, type, position] of DEFAULT_STATES) {
      db.prepare('INSERT INTO states (id, scope_id, name, type, position) VALUES (?, ?, ?, ?, ?)').run(
        id(), scopeId, name, type, position,
      );
    }
  }
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    db.prepare('INSERT INTO users (id, display_name) VALUES (?, ?)').run('local-user', 'you');
  }
}

const ISSUE_SELECT = `
  SELECT i.*, s.key AS scope_key, st.name AS state_name, st.type AS state_type,
         p.name AS project_name, u.display_name AS assignee_name,
         par.identifier AS parent_identifier
  FROM issues i
  JOIN scopes s ON s.id = i.scope_id
  JOIN states st ON st.id = i.state_id
  LEFT JOIN projects p ON p.id = i.project_id
  LEFT JOIN users u ON u.id = i.assignee_id
  LEFT JOIN issues par ON par.id = i.parent_id
`;

function toIssue(db: Db, row: Row): Issue {
  const labels = db
    .prepare('SELECT l.name, l.color FROM labels l JOIN issue_labels il ON il.label_id = l.id WHERE il.issue_id = ?')
    .all(row.id)
    .map((l) => ({ name: String(l.name), color: String(l.color) }));
  return {
    id: String(row.id),
    identifier: String(row.identifier),
    title: String(row.title),
    description: row.description ? String(row.description) : undefined,
    priority: Number(row.priority ?? 0),
    // no web UI to open: the board's `o`/`O` keys skip an empty url
    url: '',
    branchName: '',
    stateName: String(row.state_name),
    stateType: String(row.state_type) as StateType,
    labels,
    assignee: row.assignee_name ? String(row.assignee_name) : undefined,
    assigneeId: row.assignee_id ? String(row.assignee_id) : undefined,
    teamId: String(row.scope_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    projectName: row.project_name ? String(row.project_name) : undefined,
    parent: row.parent_id
      ? { id: String(row.parent_id), identifier: String(row.parent_identifier) }
      : undefined,
  };
}

export function sqlitePath(cfg: Config): string {
  return cfg.sqlitePath ?? join(STATE_DIR, 'local.db');
}

export function sqliteProvider(cfg: Config): IssueProvider {
  let db: Db | undefined;
  const conn = (): Db => (db ??= open(sqlitePath(cfg)));
  const issues = (where: string, params: unknown[] = []): Issue[] =>
    conn().prepare(`${ISSUE_SELECT} ${where}`).all(...params).map((r) => toIssue(conn(), r));

  return {
    name: 'sqlite',
    scopeLabel: 'scope',
    capabilities: {
      blockers: true,
      subIssues: true,
      priority: true,
      projects: true,
    createProjects: true,
      scopes: true,
      workflowStates: true,
      // no upstream to hand us a branch: safeBranch derives one
      branchNames: false,
      comments: true,
    },

    issues: async (scope, opts) => {
      const open = "st.type NOT IN ('completed','canceled')";
      const parts = [open];
      const params: unknown[] = [];
      if (scope && scope !== '*') {
        parts.push('s.key = ?');
        params.push(scope);
      }
      if (!opts?.includeProjects) parts.push('i.project_id IS NULL');
      const order = 'ORDER BY i.priority = 0, i.priority, i.number';
      const top = issues(`WHERE ${parts.join(' AND ')} ${order}`, params);
      if (!opts?.includeSubIssues || !top.length) return top;
      // by parent, not by relaxing the filters above — a sub-issue is hidden
      // here because it inherited a project, not because it is a sub-issue
      const ids = top.map((i) => i.id);
      const children = issues(
        `WHERE ${open} AND i.parent_id IN (${ids.map(() => '?').join(',')}) ${order}`,
        ids,
      );
      const seen = new Set(ids);
      return [...top, ...children.filter((c) => !seen.has(c.id))];
    },
    filteredIssues: async (filter: IssueFilter) => {
      const parts: string[] = [];
      const params: unknown[] = [];
      if (filter.scope) {
        parts.push('s.key = ?');
        params.push(filter.scope);
      }
      if (filter.state?.length) {
        parts.push(`st.type IN (${filter.state.map(() => '?').join(',')})`);
        params.push(...filter.state);
      } else {
        parts.push("st.type NOT IN ('completed','canceled')");
      }
      if (filter.project === null) parts.push('i.project_id IS NULL');
      else if (filter.project) {
        parts.push('p.name = ?');
        params.push(filter.project);
      }
      const rows = issues(parts.length ? `WHERE ${parts.join(' AND ')}` : '', params);
      if (!filter.labels?.length) return rows;
      const wanted = filter.labels.map((l) => l.toLowerCase());
      return rows.filter((i) => wanted.every((w) => i.labels.some((l) => l.name.toLowerCase().includes(w))));
    },
    issuesByIds: async (ids) =>
      ids.length ? issues(`WHERE i.id IN (${ids.map(() => '?').join(',')})`, ids) : [],
    subIssues: async (parentId) => issues('WHERE i.parent_id = ? ORDER BY i.number', [parentId]),
    blockers: async (issueId) =>
      conn()
        .prepare(
          `SELECT b.blocker_id AS id, i.identifier, st.type AS state_type
             FROM blocks b JOIN issues i ON i.id = b.blocker_id
             JOIN states st ON st.id = i.state_id
            WHERE b.blocked_id = ?`,
        )
        .all(issueId)
        .map((r) => ({
          id: String(r.id),
          identifier: String(r.identifier),
          done: r.state_type === 'completed' || r.state_type === 'canceled',
        })),

    scopes: async () =>
      conn().prepare('SELECT id, key, name FROM scopes ORDER BY key').all().map((r) => ({
        id: String(r.id), key: String(r.key), name: String(r.name),
      })) as Scope[],
    projects: async () => {
      const scopes = conn().prepare('SELECT id, key, name FROM scopes ORDER BY key').all();
      return conn().prepare('SELECT * FROM projects ORDER BY name').all().map((r) => ({
        id: String(r.id),
        name: String(r.name),
        description: r.description ? String(r.description) : undefined,
        state: String(r.state ?? 'started'),
        priority: r.priority == null ? undefined : Number(r.priority),
        progress: Number(r.progress ?? 0),
        targetDate: r.target_date ? String(r.target_date) : undefined,
        url: '',
        scopes: scopes.map((s) => ({ id: String(s.id), key: String(s.key), name: String(s.name) })),
        lead: r.lead ? String(r.lead) : undefined,
      })) as Project[];
    },
    projectIssues: async (projectId) => issues('WHERE i.project_id = ? ORDER BY i.number', [projectId]),
    createProject: async (input) => {
      const projectId = id();
      conn()
        .prepare(
          `INSERT INTO projects (id, name, description, content, state, progress, target_date, priority)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          projectId,
          input.name,
          // description is the line a list shows; content is the brief itself.
          // Putting the markdown in the first one turns every project row into
          // a wall of "# why".
          input.description ?? null,
          input.content ?? null,
          input.state ?? 'planned',
          input.targetDate ?? null,
          input.priority ?? 0,
        );
      // no scope join table here: a local project belongs to the whole file,
      // which is the same simplification the scopes list already makes
      return { id: projectId, name: input.name };
    },

    create: async (input: CreateIssueInput) => {
      const db = conn();
      const scope =
        db.prepare('SELECT id, key FROM scopes WHERE id = ? OR key = ?').get(input.scopeId, input.scopeId) ??
        db.prepare('SELECT id, key FROM scopes LIMIT 1').get();
      if (!scope) throw new Error('sqlite provider has no scope to create the issue in');
      const state = db
        .prepare("SELECT id FROM states WHERE scope_id = ? AND type = 'unstarted' ORDER BY position LIMIT 1")
        .get(scope.id);
      const next = Number(
        db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM issues WHERE scope_id = ?').get(scope.id)?.n ?? 1,
      );
      const issueId = id();
      const identifier = `${String(scope.key)}-${next}`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO issues (id, identifier, number, title, description, priority, state_id, scope_id,
                             project_id, parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        issueId, identifier, next, input.title, input.description ?? null, input.priority ?? 0,
        String(state?.id ?? ''), String(scope.id), input.projectId ?? null, input.parentId ?? null, now, now,
      );
      return { id: issueId, identifier };
    },
    blockIssue: async (blockerId, blockedId) => {
      conn().prepare('INSERT INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, blockedId);
    },
    assign: async (issueId, userId) => {
      conn().prepare('UPDATE issues SET assignee_id = ?, updated_at = ? WHERE id = ?').run(userId, Date.now(), issueId);
    },
    comment: async (issueId, body) => {
      conn()
        .prepare('INSERT INTO comments (id, issue_id, body, author, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id(), issueId, body, 'you', Date.now());
    },

    workflowStates: async (scopeId) =>
      conn().prepare('SELECT id, name, type, position FROM states WHERE scope_id = ? ORDER BY position').all(scopeId).map((r) => ({
        id: String(r.id), name: String(r.name), type: String(r.type), position: Number(r.position),
      })) as WorkflowState[],
    setState: async (issueId, stateId) => {
      conn().prepare('UPDATE issues SET state_id = ?, updated_at = ? WHERE id = ?').run(stateId, Date.now(), issueId);
    },

    viewer: async () => {
      const row = conn().prepare('SELECT id, display_name FROM users LIMIT 1').get();
      return { id: String(row?.id ?? 'local-user'), displayName: String(row?.display_name ?? 'you') };
    },

    branchFor: (issue) => safeBranch(issue),
  };
}
