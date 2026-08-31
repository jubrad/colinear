# Code map

Where things live. Kept out of the [documentation site](https://jubrad.github.io/colinear/) on
purpose: it is a map for someone editing this repository, and it goes stale the moment a file moves.
The site covers what colinear does; [DESIGN.md](DESIGN.md) covers how it works.

```
src/index.tsx        entry + process modes: bare `coli` supervises a TUI child (respawns it on
                     exit code 75 = `R` reload); `--tui` runs the client (alt-screen, DEC-2026
                     sync-output wrapping, stderr diversion, the attach loop TUI ⇄ interactive
                     claude/shell/editor); `daemon [status|stop]` runs/controls the backend;
                     `gc` and `contexts` are standalone chores that work with the daemon down
src/daemon.ts        the backend process: owns Dispatcher, store, persistence, PR polling and the
                     Linear sweeps; unix-socket server — hello(snapshot) then a delta stream per
                     client, commands in, toasts out; pidfile for status/stop
src/client.ts        the TUI's half: connects (spawning a detached daemon if none is up), turns the
                     local store into a mirror, and exposes DispatcherApi — the interface views call,
                     implemented for real by Dispatcher and by message-passing here
src/app.tsx          view stack + `:` command bar, AppCtx provider, global keys, header/crumbs,
                     clock (pauses when no task is timing), terminal size, toasts
src/theme.ts         palette + STATUS_COLORS
src/core/
  types.ts           all shared types: Task, TaskStatus, TriageVerdict (incl. split-plan subtasks,
                     verification tier, repo pick), PrInfo, RepoConfig, Config
  context.ts         which config + state dir this process uses (--context/-c, COLINEAR_CONTEXT,
                     COLINEAR_STATE_DIR). A leaf module evaluated before anything derives a path
                     from it; re-exports STATE_DIR through log.ts
  config.ts          ~/.config/colinear/config.json (legacy ~/.colinear.json), the context layer
                     over it, repos allowlist normalization (remote/pushRemote/prBase are GIT
                     REMOTE NAMES), --team flag
  store.ts           observable Map<issueId, Task> + version counter. Two modes: the daemon's is the
                     source of truth and emits a CDC delta per mutation; a client's is a mirror
                     (hydrate + apply) whose writes forward to the daemon instead of applying locally
  delta.ts           wire format: Change/Delta/Snapshot, WireTask (question minus its callback), and
                     encodePatch — cleared fields travel separately because JSON drops undefined
  protocol.ts        socket path, PROTOCOL_VERSION, Command/ClientMsg/ServerMsg, NDJSON codec
                     (a command the daemon has no case for is reported, not swallowed —
                     an additive command needs no version bump, but it must not go quiet)
  store.check.ts     `npm run check`: replays a realistic mutation sequence into a mirror and asserts
                     they agree (cleared fields, activity cap, answer callback, gap → re-snapshot)
  hooks.ts           useTasks(): memoized per store.version — identity stability is load-bearing (see gotchas)
  dispatcher.ts      the heart: queue + concurrency (default 3), runTask (triage→work→checks),
                     worktree management (PR-branch adoption, existing-worktree reuse), prompts
                     (taskContext block shared by all sessions), fixci mode, suspend/cancel/resume/
                     redispatch, blocked-task queueing on Linear "blocks" relations, shutdown
  agent.ts           runSession(): SDK query() wrapper — canUseTool intercepts AskUserQuestion and
                     relays the human answers via a deny message (hack; SDK "defer" would be cleaner).
                     The WHOLE question set is kept: AskUserQuestion carries up to four questions,
                     each with per-option descriptions, and answering only the first made the agent
                     re-ask the rest. Permission gates ride the same shape with allow/deny options,
                     usage/token accounting, structured output via outputFormat json_schema, resume/abort.
                     SessionInbox turns the prompt into an async iterable so the operator can push a
                     message into a live session (`M`); the session closes on `result` unless one is
                     pending, which is what keeps a normal run from hanging open
  provider.ts        the IssueProvider interface + ProviderCapabilities: the only thing the app
                     knows about issue trackers. Adapters are registered in the map here rather
                     than by import side-effect, so a refactor can't silently unregister one
  providers/shared.ts leaf helpers every adapter needs (safeBranch, stateTypeOf, ALL_SCOPES) —
                     a leaf so provider.ts can import adapters without a cycle
  providers/linear.ts GraphQL client; queryIssuesPaged (cursor pagination, 500 cap) backs all issue
                     fetches; teams/projects/viewer/labels; mutations (create/assign/state/comment);
                     fetchBlockers (inverseRelations type "blocks")
  reviews.ts         the GitHub side of PR review: one GraphQL search for PRs awaiting me
                     (diff stats + branches included, archived repos excluded), repo matching
                     by git remote (a repo's colinear name rarely equals its GitHub slug),
                     deletePendingReviews + submitReview (deterministic posting);
                     adoptReview/parsePrSpec put a PR on the list by name, for your own,
                     which the review-requested search can never return
  reviewer.ts        assisted review: worktree on the PR head, one session that writes
                     .colinear-review.md, chat turns that resume it, doc watch, and the
                     deterministic post/approve/request-changes path
  prs.ts             gh pr list per repo w/ tasks; matching: pinnedPr > branch match > identifier in
                     head/title, ranked OPEN > MERGED > CLOSED; stack chaining by baseRef; status
                     transitions (incl. un-failing error tasks that gain a live PR); CI babysitter
  statesync.ts       Linear state moves (dispatch→started, first PR→In Review), per-team state cache
  persist.ts         state.json v3: tasks (minus live question fn) + planner snapshots + UI prefs
                     the daemon owns; a view sets one over the socket (setUi), never locally;
                     debounced on store change + 10s heartbeat + flush on exit; atomic tmp+rename;
                     live statuses restore as `interrupted`
  guidance.ts        guidanceFor(scope): the general block plus whatever is scoped to this
                     prompt (triage / work / review / plan)
  coordinator.ts     EXPERIMENTAL: a tracking parent's coordinator session — prompt, family
                     snapshot, scratch cwd, and the CoordinatorTools interface the dispatcher
                     implements (message/cancel/propose against its own sub-issues only)
  channel.ts         EXPERIMENTAL coordination channels, per issue family AND per project
                     (SessionChannels is what one session belongs to; the tools' scope enum
                     holds exactly those, so membership stays enforced by construction):
                     per-channel jsonl message log +
                     per-reader cursors, behind a ChannelStore interface (the remote seam).
                     Off unless config `experimental` AND `experiments.coordination`
  gc.ts              which worktrees can go: finished tasks past a keep-window, review
                     checkouts of stale reviews, and directories no task claims (repo
                     re-routes leave those). Refuses to classify anything as an orphan
                     when no tasks loaded — empty state is indistinguishable from live work
  backup.ts          `coli backup` / `coli restore`: one archive per machine. Worktrees are
                     recorded as (git bundle of un-upstreamed commits, patch of the dirty
                     tree, tar of untracked) rather than copied — a copied worktree is inert
                     (.git is a pointer file) and git's own ignore rules drop target/ and
                     friends for free. Restore rewrites every absolute path when home moves:
                     config, state, plans, the *encoding* of transcript directory names, and
                     the transcripts' own contents (every record carries the cwd it happened
                     in, plus the files tools touched) — by extension, never by sniffing
  backupcrypt.ts     the archive's encryption: a random AES-256-GCM key for the body, wrapped
                     by scrypt over the operator's passphrase and carried in the header, so one
                     file moves and one secret is remembered; authenticated, so a tampered
                     archive fails instead of restoring
  backup.check.ts    the round trip as a gate: a whole fake installation moved between two
                     home directories, asserting on what came out (bin/check runs it)
  worktrees.ts       what git thinks is checked out vs what is there. A worktree removed by
                     anything but `git worktree remove` stays *registered* (`prunable` in
                     the porcelain), and that stale entry was what the branch lookup
                     answered with — so a resume started an agent in a deleted directory.
                     The lookup prunes, skips prunable/locked, and reports what was lost
  worktrees.check.ts clobber a checkout and prove it comes back: branch, HEAD and committed
                     work restored, uncommitted honestly not (bin/check runs it)
  diff.ts            unified diff → flat rows that know their file and new-side line number;
                     expands tabs at parse time (one character, one column) and wraps long
                     lines into visual rows; layoutMargin aligns annotations beside them
  diff.check.ts      a tab-indented diff measured in the columns a terminal actually paints:
                     every row fits its pane at every width (bin/check runs it)
  reviewer.check.ts  an info finding reaches no review body, over every caller shape and
                     every event — the guarantee that has escaped twice — and only a stale
                     anchor is read as one (bin/check runs it)
  planner.ts         :plan chat — long-lived SDK session (streaming input via AsyncIterable),
                     read-only (denies Write/Edit), parses ```json subtasks fence into drafts,
                     approve() creates Linear sub-issues; snapshot/restore for persistence
  answers.ts         the $EDITOR path for questions: renders a question set as a markdown form and
                     parses the filled-in `Answer:` blocks back (forgiving — a human edited it)
  attach.ts          `s`/`S`: in-place terminal handoff (pending-action consumed by index.tsx loop)
                     or external window via script file (Ghostty/Terminal); suspend-first for live agents
  checks.ts          per-repo shell checks in the worktree
  customviews.ts     ~/.config/colinear/views/*.json → declarative issue filters
  newissue.ts        `n`: one-off structured-output session drafts an issue from a description
  notify.ts          terminal-notifier (click-through URL) with osascript fallback
  log.ts             append log at ~/.local/state/colinear/colinear.log (also captures diverted stderr)
src/ui/              presentation primitives: Table (generic sortable), CommandBar (prompt+ranked
                     completion; rank = prefix>substring>subsequence), modals (Dispatch/EditTask/SubIssue),
                     Header/Crumbs, format helpers, AppCtx definition (context.ts)
src/views/           registry.ts maps names/aliases → components + hotkey help; issues/board/tasks/
                     task/projects/project/plan/reviews/costs/logs/gc/config/help; custom views wrap
                     IssuesView with a spec. taskActions.tsx holds the verbs a task has (cancel,
                     resume, force, rebase, attach, edit, escalate, …) plus their modals, so the
                     board and the tasks table are two renderings of one set of actions.
                     taskLens.ts is the other half of that: status words, CI text, the fuzzy
                     matcher and the sort comparator, so a query or a sort key means the same
                     thing in both views rather than being reimplemented per view.
                     BoardView draws one grid two ways — statuses as columns, or `t` to transpose
                     them into full-width rows — off the same cursor; windowColumn windows cards
                     down a column, windowLane windows cards across a row.
                     ChannelView tails a coordination channel (experimental)
src/doctor.ts        npm run doctor — env sanity CLI
```
