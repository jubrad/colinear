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
  | 'blocked'
  /** parent issue whose work happens via its sub-issues; completes when they all do */
  | 'tracking'
  /** issue closed as cancelled in Linear — parks in the Done column, distinct look */
  | 'cancelled';

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
  /** MERGEABLE / CONFLICTING / UNKNOWN — GitHub is still computing on UNKNOWN */
  mergeable?: string;
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
  /** input/output are uncached (what Claude Code's /cost calls input/output);
      cache reads/writes tracked separately — they dwarf the rest and mislead */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
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
  /** rebase this PR automatically when GitHub reports a conflict */
  autoRebase?: boolean;
  /**
   * A maintenance session is live on an already-open PR. The task keeps its
   * status throughout — it is not back in development — and the card shows a
   * blinking dot instead of moving columns.
   */
  maintenance?: 'rebase' | 'fixci';
  /** one rebase per conflict; re-arms when the PR is mergeable again */
  rebaseAttempted?: boolean;
  /** operator-pinned PR number: PR matching uses exactly this, never guesses */
  pinnedPr?: number;
  /** sub-issues a `tracking` parent is waiting on */
  subIssues?: Array<{ id: string; identifier: string; title: string; done: boolean }>;
  /**
   * Linear "blocks" relations this task is subject to. `start` parks it out of
   * the queue; `merge` lets the work happen in parallel but holds the PR in
   * draft until the blocker lands. Linear has no such distinction — forcing a
   * blocked task (`f`) is what converts one to the other.
   */
  blockedBy?: Array<{ id: string; identifier: string; kind: 'start' | 'merge'; done?: boolean }>;
  /** one automatic retry after a rate-limit failure */
  retried?: boolean;
  /** superseded session pointers — recovery when a new session clobbers a good one */
  sessionHistory?: Array<{ sessionId: string; worktree?: string; at: number }>;
}

export type ReviewStatus =
  /** listed as awaiting my review; nothing done yet */
  | 'pending'
  | 'queued'
  /** agent is reading the diff */
  | 'reviewing'
  /** findings are ready for the operator to look over */
  | 'ready'
  /** agent is posting the findings to GitHub */
  | 'posting'
  /** submitted as a COMMENT review — GitHub's own word for it */
  | 'commented'
  | 'approved'
  | 'changes_requested'
  /** no longer requesting my review (someone else took it, or it was withdrawn) */
  | 'stale'
  | 'error';

export interface ChatTurn {
  /** `note` is colinear talking, not the agent — refusals, errors, hints */
  role: 'operator' | 'agent' | 'note';
  text: string;
  at: number;
}

export type Severity = 'blocking' | 'consider' | 'nit' | 'praise';

export interface ReviewFinding {
  /** unset when the point isn't about a particular file — it goes in the body */
  file?: string;
  line?: number;
  /**
   * blocking = would request changes over it; nit = optional polish. Unset on
   * the lead entry: no file, no line, no severity, one sentence — it opens the
   * posted review.
   */
  severity?: Severity;
  comment: string;
}

/** An LLM pre-review of someone else's PR; the operator decides what to post. */
export interface Review {
  /** stable key: "<owner>/<repo>#<number>" */
  id: string;
  number: number;
  /** owner/repo as GitHub reports it */
  repository: string;
  title: string;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  status: ReviewStatus;
  activity: string[];
  /** local repo the diff was reviewed in, when one is configured */
  repo?: { name: string; path: string; worktreeRoot: string };
  worktree?: string;
  sessionId?: string;
  /** the pre-review itself: prose the operator reads, parsed findings for GitHub */
  summary?: string;
  findings?: ReviewFinding[];
  /** the full review document the agent wrote (.colinear-review.md) */
  doc?: string;
  /** conversation with the reviewing agent about this PR */
  chat?: ChatTurn[];
  /** a chat turn is in flight (the review's own status doesn't change) */
  chatting?: boolean;
  /** operator's own note, appended to whatever gets posted */
  note?: string;
  /** what was sent to GitHub, so a later discussion knows it's already out */
  posted?: { at: number; event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'; url: string; comments: number };
  startedAt?: number;
  endedAt?: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: number;
  error?: string;
  question?: PendingQuestion;
}

/** Operator's edits from the board's `m` modal; applied by the dispatcher. */
export interface TaskEdits {
  repo: RepoConfig;
  /** undefined = auto-match, number = pinned */
  pinnedPr?: number;
  instructions?: string;
  model?: string;
  retriage: boolean;
  /** true = straight to work, false = triage wanted, undefined = keep as-is */
  skipTriage?: boolean;
  /** rebase this task's PR automatically on conflict (undefined = follow config) */
  autoRebase?: boolean;
  /** true when the operator asked to requeue (ctrl+r) */
  requeue: boolean;
}

/** Which prompt a piece of standing guidance applies to. */
export type GuidanceScope = 'triage' | 'work' | 'review' | 'plan';

export type Guidance = { general?: string } & Partial<Record<GuidanceScope, string>>;

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
  /**
   * Operator's standing guidance. `general` reaches every agent; the rest add
   * to it for one kind of work. House rules that outlive any one issue —
   * code style, what a good PR looks like. Per-task `instructions` outrank it.
   */
  guidance: Guidance;
  /**
   * Appended to what colinear posts on a PR — e.g. "written by claude on
   * behalf of @jubrad". Unset posts nothing extra.
   */
  prSignoff?: string;
  /**
   * Where the signoff goes: "all" signs the review body and every inline
   * comment; "body" signs only the body, so a review with six findings
   * carries one attribution instead of seven.
   */
  prSignoffScope: 'all' | 'body';
  /** Linear team key (e.g. "CLOUD") to browse; unset = my assigned issues */
  team?: string;
  /** macOS notifications on needs_input / done / error (default true) */
  notifications: boolean;
  /** auto-move Linear states: dispatch -> started, PR -> In Review (default true) */
  stateSync: boolean;
  /** auto-dispatch a fix session when a task's PR checks go red (default true) */
  ciAutofix: boolean;
  /** default for a task's autoRebase; a conflicting PR gets a rebase session */
  autoRebase: boolean;
  /**
   * How long finished work stays on the board, in days. Past this a done,
   * cancelled or settled review is dropped from the store — which is also the
   * window the header's token and cost figures cover. 0 keeps everything.
   */
  retentionDays: number;
  /** UI refresh tick in ms — raise it (e.g. 2000) if your terminal/mux flickers (default 1000) */
  tickMs: number;
  /** permission mode for interactive attach sessions (default "acceptEdits", matching headless agents) */
  attachPermissionMode: string;
  /** terminal for session attach: "ghostty" | "terminal" (default: Ghostty if installed) */
  terminal?: string;
}
