export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  priority: number;
  url: string;
  branchName: string;
  stateName: string;
  labels: Array<{ name: string; color: string }>;
  assignee?: string;
  assigneeId?: string;
  stateType?: string;
  teamId?: string;
  projectId?: string;
}

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export interface LinearProject {
  id: string;
  name: string;
  description?: string;
  state: string;
  /** 0..1 */
  progress: number;
  targetDate?: string;
  url: string;
  teams: LinearTeam[];
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export type TaskStatus =
  | 'queued'
  | 'triage'
  | 'working'
  | 'checks'
  | 'needs_input'
  | 'pr_open'
  | 'escalated'
  | 'done'
  | 'error'
  /** restored from a previous run while the agent was mid-flight */
  | 'interrupted';

export interface TriageVerdict {
  verdict: 'do' | 'too_big' | 'needs_info';
  reason: string;
  plan?: string;
}

export interface PendingQuestion {
  text: string;
  options: string[];
  answer: (a: string) => void;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  checksStatus: string;
  headRefName: string;
  baseRefName: string;
}

export interface Subtask {
  text: string;
  done: boolean;
}

export interface Task {
  issue: LinearIssue;
  status: TaskStatus;
  /** status to restore when a pending question is answered */
  statusBeforeQuestion?: TaskStatus;
  activity: string[];
  subtasks: Subtask[];
  tokens: { input: number; output: number };
  startedAt?: number;
  endedAt?: number;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  verdict?: TriageVerdict;
  question?: PendingQuestion;
  checks: CheckResult[];
  prs: PrInfo[];
  error?: string;
  costUsd: number;
  escalationCommented?: boolean;
  /** one automatic retry after a rate-limit failure */
  retried?: boolean;
}

export interface CheckConfig {
  name: string;
  cmd: string;
}

export interface Config {
  linearApiKey: string;
  /** absolute path to the repo agents work on */
  repo: string;
  defaultBranch: string;
  /** where per-issue worktrees are created */
  worktreeRoot: string;
  concurrency: number;
  checks: CheckConfig[];
  model?: string;
  /** Linear team key (e.g. "CLOUD") to browse; unset = my assigned issues */
  team?: string;
  /** macOS notifications on needs_input / done / error (default true) */
  notifications: boolean;
  /** auto-move Linear states: dispatch -> started, PR -> In Review (default true) */
  stateSync: boolean;
}
