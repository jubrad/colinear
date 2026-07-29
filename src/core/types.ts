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
  /** set when this issue is a sub-issue */
  parent?: { id: string; identifier: string };
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
  lead?: string;
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
  | 'interrupted'
  /** waiting on Linear blocking issues to complete */
  | 'blocked';

export type Verification = 'local-light' | 'ci' | 'needs-env';

export interface PlannedSubtask {
  title: string;
  description: string;
  priority?: number;
  /** repo name from the config allowlist */
  repo?: string;
  /** indices into the subtasks array of items that must finish first */
  blockedBy?: number[];
}

export interface TriageVerdict {
  verdict: 'do' | 'too_big' | 'needs_info';
  reason: string;
  plan?: string;
  /** how the change should be verified (drives the work-pass test strategy) */
  verification?: Verification;
  /** repo (by config name) triage decided the work belongs in */
  repo?: string;
  /** too_big only: proposed single-repo sub-issues with dependencies */
  subtasks?: PlannedSubtask[];
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
  /** APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED (unset = no reviews yet) */
  reviewDecision?: string;
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
  /** user-provided special instructions passed to triage + work prompts */
  instructions?: string;
  /** operator chose to go straight to the work pass */
  skipTriage?: boolean;
  /** per-dispatch model override (falls back to config model) */
  model?: string;
  /** repo this task works on (defaults to the first configured repo) */
  repo?: { name: string; path: string; defaultBranch: string; remote?: string; pushRemote?: string; prBase?: string; worktreeRoot: string };
  /** set while a CI-failure fix has been dispatched for the current red rollup */
  ciFixAttempted?: boolean;
  /** operator-pinned PR number: PR matching uses exactly this, never guesses */
  pinnedPr?: number;
  /** unresolved Linear blockers keeping this task out of the queue */
  blockedBy?: Array<{ id: string; identifier: string }>;
  /** one automatic retry after a rate-limit failure */
  retried?: boolean;
}

export interface CheckConfig {
  name: string;
  cmd: string;
}

/** A repo agents are allowed to work on (always via worktrees, never in place). */
export interface RepoConfig {
  name: string;
  /** what lives here — triage uses this to route issues to the right repo */
  description?: string;
  path: string;
  defaultBranch: string;
  /** upstream remote: worktree base + the repo PRs target (default "origin") */
  remote: string;
  /** remote branches are pushed to — your fork in a fork workflow (default: remote) */
  pushRemote: string;
  /** branch PRs are opened against (default: defaultBranch, i.e. "main") */
  prBase: string;
  worktreeRoot: string;
  checks: CheckConfig[];
}

export interface Config {
  linearApiKey: string;
  /** repos agents may work on; first entry is the default */
  repos: RepoConfig[];
  /** absolute path to the default repo (mirror of repos[0].path) */
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
  /** auto-dispatch a fix session when a task's PR checks go red (default true) */
  ciAutofix: boolean;
  /** UI refresh tick in ms — raise it (e.g. 2000) if your terminal/mux flickers (default 1000) */
  tickMs: number;
  /** terminal for session attach: "ghostty" | "terminal" (default: Ghostty if installed) */
  terminal?: string;
}
