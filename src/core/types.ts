/**
 * An issue, as colinear needs it — the shape every provider maps into.
 *
 * `identifier` is load-bearing well beyond display: it names branches,
 * worktree directories and coordination channels, and PR matching looks for it
 * in branch names and titles. A provider must supply something short, unique
 * across the repos in play, and safe in a path and a git ref.
 */
export interface Issue {
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
  /** normalized lifecycle bucket; providers map their own vocabulary into it */
  stateType?: StateType;
  /** the scope this issue lives in — a Linear team, a Jira project, a repo */
  teamId?: string;
  projectId?: string;
  /** carried so a project channel can be named after the project, not its uuid */
  projectName?: string;
  /** set when this issue is a sub-issue */
  parent?: { id: string; identifier: string };
}

/**
 * The dimension above an issue: a team in Linear, a project in Jira, a repo in
 * GitHub. `IssueProvider.scopeLabel` is what the UI calls it.
 */
export interface Scope {
  id: string;
  key: string;
  name: string;
}

/**
 * Issue lifecycle, normalized. Linear reports exactly these; Jira maps its
 * status categories; GitHub has only open/closed, so it can only ever answer
 * `unstarted` or `completed`/`canceled` — which is why anything that depends
 * on `started` has to be capability-gated rather than assumed.
 */
export type StateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | 'triage';

export interface Project {
  id: string;
  name: string;
  description?: string;
  state: string;
  /** 0..1 */
  progress: number;
  targetDate?: string;
  url: string;
  scopes: Scope[];
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

export interface QuestionOption {
  label: string;
  /** what picking this means — the agent writes it, and it's most of the value */
  description?: string;
}

export interface AskedQuestion {
  /** short chip the agent supplies ("Auth method"), if any */
  header?: string;
  text: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/**
 * What an agent is waiting on. AskUserQuestion sends up to four questions at
 * once, each with its own options and per-option descriptions, so this models
 * the whole set — answering one of four and discarding the rest was why the
 * agent kept asking again.
 */
export interface PendingQuestion {
  questions: AskedQuestion[];
  /** a permission gate reads differently from a question about the work */
  kind: 'ask' | 'permission';
  /** one answer per question, in order */
  answer: (answers: string[]) => void;
}

/** One-line form for cards, notifications and logs. */
export function questionSummary(q: PendingQuestion): string {
  const first = q.questions[0]?.text ?? 'needs input';
  return q.questions.length > 1 ? `${first} (+${q.questions.length - 1} more)` : first;
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
  issue: Issue;
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
  /**
   * Dispatched manually: the worktree exists and the card sits in Working, but
   * no agent has been started. `r` starts one — the point is to lay a skeleton
   * down by hand first (a design doc, a file layout) and have the agent pick it
   * up rather than invent its own.
   */
  awaitingStart?: boolean;
  /** set while a CI-failure fix has been dispatched for the current red rollup */
  ciFixAttempted?: boolean;
  /** rebase this PR automatically when GitHub reports a conflict */
  autoRebase?: boolean;
  /** dispatch sub-issues that turn up on this parent (undefined = follow config) */
  autoDispatchSubs?: boolean;
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
   * Sub-issues a coordinator session proposed. They are not created: the
   * operator reviews them on the parent (`A` creates, `D` creates and
   * dispatches), because nothing reaches Linear without being asked.
   */
  proposals?: PlannedSubtask[];
  /**
   * Linear "blocks" relations this task is subject to. `start` parks it out of
   * the queue; `merge` lets the work happen in parallel but holds the PR in
   * draft until the blocker lands. Linear has no such distinction — forcing a
   * blocked task (`f`) is what converts one to the other.
   */
  blockedBy?: Array<{ id: string; identifier: string; kind: 'start' | 'merge'; done?: boolean }>;
  /** one automatic retry after a rate-limit failure */
  retried?: boolean;
  /**
   * Operator messages typed while no session was live (`M`). They ride into
   * the next session's opening prompt and are cleared once delivered; a live
   * agent gets them pushed straight into its conversation instead.
   */
  inbox?: string[];
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
  /** dispatch new sub-issues of this parent automatically (undefined = follow config) */
  autoDispatchSubs?: boolean;
  /** true when the operator asked to requeue (ctrl+r) */
  requeue: boolean;
}

/**
 * Features that work but aren't settled — shape, cost or prompt discipline
 * may change, and they can affect what agents do. Each is off unless the
 * master `experimental` switch AND its own flag are on.
 */
export type ExperimentName = 'coordination';

export const EXPERIMENTS: Record<ExperimentName, string> = {
  coordination: 'family coordination channels: sub-issue agents get a shared channel (:chan)',
};

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
  /** which issue tracker this context talks to (default "linear") */
  provider: string;
  /** sqlite provider: where the tracker lives (default <state dir>/local.db) */
  sqlitePath?: string;
  /**
   * Demo mode: a fabricated board, scripted agents, no network. Nothing is
   * dispatched for real, nothing is billed, and no PR or review is ever
   * fetched or posted. For showing colinear, screenshotting it, and testing
   * the UI without an account or an agent budget.
   */
  demo?: boolean;
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
   * Default for a task's autoDispatchSubs: when a tracking parent gains a
   * sub-issue nobody has started, dispatch it. Off by default — creating an
   * issue and spending an agent on it are not the same statement.
   */
  autoDispatchSubs: boolean;
  /**
   * How long finished work stays on the board, in days. Past this a done,
   * cancelled or settled review is dropped from the store — which is also the
   * window the header's token and cost figures cover. 0 keeps everything.
   */
  retentionDays: number;
  /**
   * How long a finished task's worktree is kept before `coli gc` / `:gc` offer
   * it (default 7). Separate from `retentionDays`: a checkout is exactly what
   * you want the day a task lands, long after the card stops being interesting.
   */
  worktreeRetentionDays: number;
  /**
   * Master switch for unfinished features. Nothing in `experiments` runs
   * unless this is true — one place to turn all of it off when an experiment
   * misbehaves, without editing the per-feature flags you want to keep.
   */
  experimental: boolean;
  /** per-feature opt-in; only consulted when `experimental` is true */
  experiments: Partial<Record<ExperimentName, boolean>>;
  /** UI refresh tick in ms — raise it (e.g. 2000) if your terminal/mux flickers (default 1000) */
  tickMs: number;
  /**
   * Permission mode for headless agents (default "auto": a classifier approves
   * routine work and anything risky falls through to you as an allow/deny
   * question). "acceptEdits" is narrower, "bypassPermissions" asks nothing —
   * that one hands an unattended agent your shell, so it is yours to choose
   * deliberately.
   */
  agentPermissionMode: string;
  /** permission mode for interactive attach sessions (default "auto", matching headless agents) */
  attachPermissionMode: string;
  /**
   * Operator-level permission rules, applied to every agent as policy. Unlike a
   * repo's own .claude/settings.json — which lives inside the worktree an agent
   * can write to — these come from your config and cannot be loosened by the
   * project, the model, or a prompt.
   *
   * Bare tool names ("Read", "WebFetch") or Claude Code rule patterns
   * ("Bash(cat:*)", "Bash(git push --force:*)"). Both are refused outright —
   * there is no "ask" tier here, because the SDK has no option that routes a
   * matched rule to a prompt, and a knob that quietly does nothing is worse
   * than no knob.
   */
  denyTools: string[];
  /** terminal for session attach: "ghostty" | "terminal" (default: Ghostty if installed) */
  terminal?: string;
  /**
   * Where this context's daemon runs. Unset — the default — means local, and
   * nothing about colinear changes. Set it and the client stops assuming the
   * daemon's paths exist here: attach, shell and doc editing run through
   * `exec`, and anything read from the daemon's disk comes over the socket.
   *
   * `exec` is a command prefix that takes ONE shell-command argument:
   *   ssh:     ["ssh", "-t", "vm"]
   *   docker:  ["docker", "exec", "-it", "coli", "sh", "-lc"]
   *   kubectl: ["kubectl", "exec", "-it", "pod/coli", "--", "sh", "-lc"]
   *
   * `{ "ssh": "vm" }` is sugar for the first. See docs/remote.md.
   */
  remote?: {
    exec: string[];
    label: string;
    /** the ssh destination, when this remote came from `{ "ssh": "vm" }` — the
        only form that can forward a unix socket for us */
    ssh?: string;
    /** open (and own) the ssh tunnel to the daemon's socket automatically */
    forward?: boolean;
    /** the daemon's socket path on that machine; discovered when omitted */
    socket?: string;
  };
}
