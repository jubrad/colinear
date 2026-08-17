# colinear — design notes

Context doc for anyone (human or Claude session) picking this codebase up. README.md covers usage; this covers how it works, where things live, and the hard-won gotchas. Keep both updated when behavior changes.

## What it is

A k9s-style Ink TUI that dispatches Claude Code agents (via `@anthropic-ai/claude-agent-sdk`) against Linear issues. One git worktree per issue, kanban board of agent progress, draft-PR-only output, human-in-the-loop for questions/escalations/promotion. Runs on Claude subscription auth: the SDK uses the logged-in `claude` CLI when `ANTHROPIC_API_KEY` is unset — never set that env var here.

Stack: TypeScript (strict, NodeNext ESM — all internal imports use `.js` suffixes), React 18 + Ink 5, no test framework. `npm run dev` = tsx; `npm run build` = tsc → `dist/` (`coli`/`colinear` bins via `npm link` run dist, so **rebuild after changes**).

## Code map

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
  linear.ts          GraphQL client; queryIssuesPaged (cursor pagination, 500 cap) backs all issue
                     fetches; teams/projects/viewer/labels; mutations (create/assign/state/comment);
                     fetchBlockers (inverseRelations type "blocks")
  reviews.ts         the GitHub side of PR review: one GraphQL search for PRs awaiting me
                     (diff stats + branches included, archived repos excluded), repo matching
                     by git remote (a repo's colinear name rarely equals its GitHub slug),
                     deletePendingReviews + submitReview (deterministic posting)
  reviewer.ts        assisted review: worktree on the PR head, one session that writes
                     .colinear-review.md, chat turns that resume it, doc watch, and the
                     deterministic post/approve/request-changes path
  prs.ts             gh pr list per repo w/ tasks; matching: pinnedPr > branch match > identifier in
                     head/title, ranked OPEN > MERGED > CLOSED; stack chaining by baseRef; status
                     transitions (incl. un-failing error tasks that gain a live PR); CI babysitter
  statesync.ts       Linear state moves (dispatch→started, first PR→In Review), per-team state cache
  persist.ts         state.json v2: tasks (minus live question fn) + planner snapshots + UI prefs;
                     debounced on store change + 10s heartbeat + flush on exit; atomic tmp+rename;
                     live statuses restore as `interrupted`
  guidance.ts        guidanceFor(scope): the general block plus whatever is scoped to this
                     prompt (triage / work / review / plan)
  coordinator.ts     EXPERIMENTAL: a tracking parent's coordinator session — prompt, family
                     snapshot, scratch cwd, and the CoordinatorTools interface the dispatcher
                     implements (message/cancel/propose against its own sub-issues only)
  channel.ts         EXPERIMENTAL coordination channels: per-family jsonl message log +
                     per-reader cursors, behind a ChannelStore interface (the remote seam).
                     Off unless config `experimental` AND `experiments.coordination`
  gc.ts              which worktrees can go: finished tasks past a keep-window, review
                     checkouts of stale reviews, and directories no task claims (repo
                     re-routes leave those). Refuses to classify anything as an orphan
                     when no tasks loaded — empty state is indistinguishable from live work
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
                     ChannelView tails a coordination channel (experimental)
src/doctor.ts        npm run doctor — env sanity CLI
```

## Process model

Two processes. The **daemon** owns everything stateful — dispatcher, store, persistence, PR polling,
Linear sweeps — so agents outlive the terminal; the **TUI** is a client that mirrors its state. `coli`
starts both (daemon only if one isn't up); `coli daemon stop` is the only thing that interrupts agents.

State reaches the client by change data capture: hydrate from a snapshot, then follow deltas stamped
with the version they produced. A delta that doesn't follow the mirror's version is refused and the
client asks for the tail it's due (or a fresh snapshot if it fell off the 1000-entry log).

The split is deliberately invisible to views:

- **Reads** — the mirror is a Store with the same API, so `useTasks()`/`store.get()` are unchanged.
- **Writes** — `store.update()` on a mirror forwards a Change to the daemon and applies nothing
  locally; the authoritative delta comes back. Never make a mirror mutate directly, or it diverges.
- **Callbacks** — `question.answer` can't cross a socket, so the mirror synthesizes one that sends
  `{answer, id, text}`; the real closure lives in the daemon. Auto-mode allow/deny rides the same path.
- **Policy stays in the backend.** `applyEdits` (the board's `m` modal) is a dispatcher method because
  whether an agent still needs to run depends on what re-polling finds — that decision can't straddle
  the wire. Its result comes back as a `toast` message.

`R` reloads the frontend: the TUI exits 75 and the supervisor respawns it on the new build, daemon
untouched. Still client-side and therefore lost on reload: the `:plan` planner session and `n`
new-issue drafting. Moving those behind the daemon is the obvious next step.

## Experiments

Features that work but aren't settled sit behind two flags: `experimental` (master) and
`experiments.<name>`. `experimentOn(cfg, name)` is the only way to ask; both must be true.
Two switches rather than one because the master is how you turn everything off at once
after a bad session, without losing which features you'd chosen. A feature named while the
master is off, or a name that isn't an experiment, is logged — an experiment that silently
doesn't run wastes an afternoon.

`EXPERIMENTS` in types.ts is the registry (name → one-line description); adding a feature
means adding a key there, gating it with `experimentOn`, and documenting it in README's
experiments table. Experimental views stay registered when disabled and explain how to turn
themselves on — a `:chan` that says "unknown view" teaches nothing.

Live experiment: **coordination channels** (COORDINATION.md). Worth knowing structurally:
the agent tools are an in-process MCP server built per session with the channel and username
closed over, so identity can't be spoofed by prompt; the message log lives in the state dir
and is written by the daemon, which is why the TUI polls it and sends operator posts back
over the socket instead of appending itself.

## Contexts

A context is a config file plus a state directory, and because the socket lives in that directory
it is also a whole separate daemon — two contexts can run at once and neither sees the other's
tasks. `--context work` / `-c work` / `COLINEAR_CONTEXT=work` select one; the default context keeps
the historical paths exactly.

Two constraints shaped the implementation:

- **Resolution has to happen before any path is derived.** `STATE_DIR` and `SOCKET_PATH` are
  module-level constants, and ESM evaluates imports before the importing module's body — so
  parsing argv in index.tsx would be too late. `core/context.ts` is a leaf module that resolves at
  its own evaluation time and everything path-shaped imports it.
- **Children must inherit it.** Rather than thread a flag through the supervisor's TUI spawn and
  the client's detached daemon spawn, resolution sets `COLINEAR_CONTEXT` in `process.env` when the
  context isn't default. Every spawn site inherits the environment and stays unaware contexts exist.

Config layering is one shallow merge of the context file over the base config (`{...base, ...ctx}`),
so shared settings are written once and top-level keys replace wholesale — a context that sets
`repos` gets exactly those. A named context with no file is a hard error rather than a fallback to
the default: dispatching agents into the wrong workspace is not a recoverable mistake. So is a
config file that exists and doesn't parse, which used to fall through to built-in defaults and run
against `~/work/cloud` with none of your settings.

Constraint on the UI side: every view sizes its panes against a **four-row header**
(`ctx.size.rows - 12` and friends), so the context indicator rides on the existing Repo row rather
than taking a fifth.

## Task lifecycle

`queued → triage → working → checks → done|pr_open` with detours:
- `blocked` (Linear blockers open; rechecked every 60s + on merges/completions). Linear has one
  kind of "blocks"; colinear has two. A blocker starts as `start` (parks the task); `f` converts
  it to `merge`, which dispatches the work in parallel but keeps it on the task — the agent's
  prompt says what it is building ahead of, and `d` refuses to promote the PR until the blocker
  lands. Deployment is outside what colinear can see, so `D` overrides.
- `needs_input` (agent AskUserQuestion, or too_big/needs_info triage verdicts — split-plan review lives here)
- `interrupted` (restart/suspend/attach; `r` resumes the SDK session by id)
- `error` (failures; auto-unfails if a live PR turns up), `escalated` (legacy; verdicts now park as needs_input)
- new sub-issues: the tracking sweep dispatches ones nobody has started when `autoDispatchSubs`
  is on for that parent (or globally). `autoDispatchable()` is the whole rule and is pure —
  the Linear state, not the absence of a task, is what makes a sub-issue eligible, so a task
  dropped by retention long after it finished can't be resurrected. Capped per sweep
- `coordinate` mode: a tracking parent woken by a message (or `r`) runs a coordinator session
  instead of a work session — no worktree, no checks, no PR, and the status stays `tracking`.
  Its tools can message and cancel its own sub-issues and propose new ones; creating them stays
  behind the operator's `A`, which is the same review UI a too_big split uses
- maintenance modes (fixci, rebase) run against an already-open PR: the task keeps its status
  and shows a blinking dot instead of moving back to Working, and the repo's checks are left to
  the prompt rather than re-run here (which would flip the card to `checks` for no new signal)
- fixci mode: red PR rollup → resume session with failing logs, one attempt per red, re-arms on green
- rebase mode: PR conflicts with its base → session that rebases and force-with-leases, same
  one-attempt-per-conflict shape. `mergeable: UNKNOWN` means GitHub is still computing and never
  triggers one. The prompt confines it to the rebase: resolve, test, push, no scope changes,
  AskUserQuestion when a conflict needs a human decision

Work sessions are **streaming-input** conversations (`SessionInbox`): the prompt is an async
iterable that yields the opening prompt and then whatever the operator sends with `M`. The catch
is termination — a streaming session waits for more input instead of ending, so `runSession`
closes the stream when a `result` arrives with nothing pending. Miss that and every task hangs
forever. Triage keeps a plain string prompt: it is short, structured-output, and nobody needs to
message it. Messages for a task with no live session are stored on `task.inbox` and rendered into
the next session's opening prompt — and, unless the operator said otherwise, `Dispatcher.wake()`
queues the task so that session happens now. Waking deliberately skips `blocked` (a message is
not a reason to jump a dependency), `tracking` and already-queued tasks, and it pushes onto the
queue like `resume()` rather than going through `enqueue()`, so no Linear state moves.

Delivery is best-effort in one specific way worth knowing: the SDK pulls from the input stream as
soon as something is yielded, long before the agent acts on it, so a pushed message is only
*certainly* delivered once a turn completes behind it. `SessionInbox` tracks that window as
`inFlight`, clears it on each `result`, and hands anything still open back to the task when the
session ends. The bias is towards repeating a message rather than losing one.

Sessions are Claude Code sessions keyed by worktree cwd (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). colinear stores only the session id + worktree; interactive attach (`claude --resume`) and headless resume share the same transcript.

## PR review

A second entity beside tasks, with the same CDC contract (`review-*` deltas, keyed
`owner/repo#number`). `gh` search finds PRs awaiting my review every 5 minutes; `r` checks the
PR's head out in `<repo>-worktrees/review-<n>` and runs one session.

**The document is the artifact.** The agent writes `.colinear-review.md` (git-excluded) —
prose for the operator, ending in a ```findings fence holding a JSON array. Findings are
parsed from that fence, so a chat turn that changes the agent's mind can't leave prose and
findings disagreeing; structured output would have needed a second pass to keep them in sync.
The daemon watches the file, so it fills in as it's written and picks up edits made anywhere.

**Posting is deterministic — no session.** The findings are already structured, so colinear
clears any pending review of ours (GitHub allows one per user per PR, and a leftover blocks
every new one), then calls `gh api` itself. An agent posting could finish happily with the
`gh` call inside it having failed; this can't. Approve and request-changes are the same call
with a different event, so a verdict carries the written review.

What reaches GitHub is deliberately small, because the document is written for the operator
and none of it belongs on someone else's PR:

- **inline comments** — one per finding with a `file` and a `line`
- **the body** — the lead finding (no file/line/severity, one sentence), a count by severity,
  an `## Other` section for findings with no line, and the operator's `n` note
- `prSignoff` / `prSignoffScope` append an attribution to all of that, or just the body

Findings survive missing fields: no `line` or no `file` means the body rather than the bin;
only a missing `comment` drops one. A line outside the diff makes GitHub reject the whole
review, so the post retries once with everything in the body.

## Retention

Nothing left the store until `retentionDays` (default 30): done and cancelled tasks and settled
reviews are dropped by a sweep on the 60s tick, which is also the window the header's token and
cost figures cover — a total over "everything colinear has ever seen" answers no question anyone
has. Anything live, questioning, erroring or PR-open is never touched, however old.

That needed the store's first delete: `delete` / `review-delete` deltas, so a mirror drops the row
instead of keeping a ghost the daemon has forgotten.

## Disk

A worktree is a full checkout: materialize is ~30G each, and one accumulates per task and
per PR reviewed. Nothing reclaimed them until `coli gc` / `:gc`, which is why 249G had piled
up by the time this was written.

Three sources: finished tasks (kept for a window — a worktree is exactly what you want the
day a task completes), review checkouts (released when the review goes stale, meaning the PR
merged, closed, or someone else took it — *not* when it's posted, since the author may push
again), and orphans (repo re-routes and removed tasks leave directories no task claims).

Removal reports per worktree as it goes (a 60G tree is not instant) and only counts one as reclaimed once the directory is actually gone. The daemon removes them so the store's pointers get cleared in the same step; `coli gc` reads
state.json directly so it also works with the daemon down. Both refuse to report orphans when
the task list is empty — that state is indistinguishable from "state failed to load", where
every live worktree looks dead.

## Prompts

All agent-facing text lives at the bottom of dispatcher.ts. `taskContext()` renders the shared context block (issue+description+parent, repo/remotes/branch, PRs with pin markers, triage verdict/plan, operator instructions) and heads every work/resume/fixci prompt. Invariants encoded in prompts: draft PRs only (`gh pr ready` forbidden — human presses `d`), adopt existing PRs (never duplicate), subtask checklist file `.colinear-subtasks.md` (git-excluded per worktree, polled every 2s onto the card), verification tiers, fork-workflow rules.

## Testing strategy

No unit tests (deliberate for now — UI-heavy, fast-moving). The verification loop is:

1. `npx tsc --noEmit` — must be clean before every commit. **Ignore editor/LSP diagnostics in this repo; they are chronically stale — trust tsc.**
2. `npm run build` — refreshes dist so the linked `coli` binary picks up changes.
3. `npm run check` — CDC replay: mirror must match the source store exactly.
4. Smoke boot: `LINEAR_API_KEY=lin_api_dummy script -q /dev/null timeout 5 npm run dev >/dev/null 2>&1` → it rendered if you see board chrome. Ignore the exit code: macOS `script` doesn't propagate its child's status, so it is not evidence of anything. Note this now *starts a daemon* against your real config and state — `coli daemon stop` afterwards, and don't enqueue fake issues into a daemon holding live state.
5. Real verification is dogfooding against the live Linear workspace; `~/.local/state/colinear/colinear.log` catches runtime errors and diverted stderr (React warnings land there — check it when behavior is weird).

If adding tests someday: core/ is mostly pure-ish and dependency-injectable (store is a singleton — the main obstacle); prs.ts matching and dispatcher redispatch/adoption logic are the highest-value targets.

## Rendering gotchas (hard-won — do not relearn these)

- **A pane that overflows by one row loses its title.** Ink paints the overflow over the first
  line rather than clipping the last, so a fixed-height pane must slice its content to
  `height - borders - header rows`. Both panes of the review modal hit this the moment an
  error line appeared above the doc.
- **A question is a set, not a string.** `PendingQuestion` holds every question the agent asked
  (1–4) with per-option descriptions, and `answer` takes an array in the same order. The wire
  format carries the set minus the callback, which the mirror rebuilds; `npm run check` asserts a
  two-question set with descriptions survives the round trip.
- **An empty `<Text>` has no height**, so blank lines vanish and markdown paragraphs run
  together — render `' '` for them.
- **Edits are popups; whole surfaces are full screen.** Anything that edits a thing — the task
  form, custom dispatch, the answer form, the sub-issue picker, messaging an agent — floats over
  the view it was opened from via `Popup`, because the context you are editing against is worth
  keeping on screen. Full screen is for surfaces rather than edits: `:config`'s `$EDITOR` handoff,
  the PR review doc + discussion split. A one-line y/n confirmation (`:gc`, review posting) is
  neither — it stays inline at the foot of its view.
- **Modals are popups, and two things make that work.** Ink supports `position="absolute"`, so
  `Popup` (ui/Popup.tsx) floats a dialog over the view instead of displacing it — but Ink only
  writes cells that hold characters, so an absolute bordered box is **transparent**: the board
  shows through every gap between its own words. Hence the backdrop, an explicit block of spaces
  at the same coordinates drawn first. And **absolute boxes paint in tree order**: a popup
  rendered before its siblings is silently overdrawn by them, so it goes last in the view.
  Height is passed in rather than measured (yoga lays out after we'd need it); overshooting just
  makes the dialog roomier, undershooting clips it, so callers round up.
- **A view's vertical budget is `rows - 8`** (`- 4` more while the command bar is open): the
  app pane is `rows - 4 - 2 - cmd` and its border costs 2. Anything with a fixed-height
  companion — TasksView's 15-row detail pane — has to subtract it *and* the table's own header
  and count rows, and drop the companion when what's left is unreadable.

- **Ink full-clears every frame when output height ≥ terminal rows (equality included).** Root box renders `rows - 1` lines, `overflow="hidden"`, fixed heights on panes. Violate this and the app "vibrates".
- **Identity stability is load-bearing.** useTasks memoizes per store.version; BoardView's cursor-clamp effect returns the same object when unchanged. A fresh-array-every-render regression once caused an infinite render loop that looked like terminal flicker (React "Maximum update depth" — found via the stderr diversion).
- Frames are wrapped in DEC 2026 synchronized-output guards (index.tsx) so supporting terminals paint atomically; stderr is diverted to the log while the TUI owns the screen; the clock stops when nothing is timing. All three exist to kill flicker — keep them.
- Avoid ambiguous-width glyphs (⎈ ？ etc.) in always-visible chrome: terminals render them 2 cells, Ink counts 1, lines wrap, height overflows.
- **An empty needle used to fuzzy-match everything.** `fuzzyMatch(x, '')` returned true on the first
  character (`i === needle.length` is `0 === 0`), so a bare `:plan` resolved to whatever project came
  back first — and started a planner agent against it. Empty now means no match; callers that mean
  "no filter" special-case it themselves.
- Key input: views gate their useInput with `isActive` (modals/bars/cmdOpen); AppCtx.setCapture disables global keys while text inputs own the keyboard; setEscHandler lets a view consume esc (clear filters) before the stack pops.

## State & files

| what | where |
|---|---|
| config | `~/.config/colinear/config.json` |
| contexts | `~/.config/colinear/contexts/<name>.json` (layered over the config above) |
| custom views | `~/.config/colinear/views/*.json` |
| task/planner/UI state | `~/.local/state/colinear/state.json` (pruned by `retentionDays`) |
| debug log + diverted stderr | `~/.local/state/colinear/colinear.log` |
| coordination channels (experimental) | `~/.local/state/colinear/channels/*.jsonl` + `cursors.json` |
| socket + pidfile | `~/.local/state/colinear/coli.sock`, `coli.pid` |
| attach scripts | `~/.local/state/colinear/attach-*.sh` |
| worktrees | `<repo>-worktrees/<ISSUE-KEY>` (per repo config) |
| session transcripts | `~/.claude/projects/<encoded-worktree>/<session>.jsonl` (Claude Code's, not ours) |

Every `~/.local/state/colinear/` path above moves under `contexts/<name>/` in a non-default context;
`COLINEAR_STATE_DIR` overrides the lot (tests set it so they can't touch a live daemon's socket).

## Known hacks / debt

- AskUserQuestion answers ride back on a `behavior: "deny"` message (agent told it's not an error). SDK's `defer` mechanism is the cleaner replacement.
- store is a module singleton; version-counter subscription, not granular. In client mode the
  singleton *is* the mirror — which is what keeps views ignorant of the split, but it also means
  nothing stops daemon-only code from being imported into the client and silently mutating a mirror.
- Snapshots are whole-store; fine at this scale (activity is capped at 200 lines/task) but a diffed
  snapshot is the obvious next move if boards get big.
- The planner and new-issue sessions still run in the TUI process, so `R`/quit kills them.
- `escalated` status is vestigial (verdicts now park as needs_input) but kept for old persisted state.
- Interactive attach + headless resume share one session id; concurrent writers are prevented by suspend-first, not enforced.
- No pagination UI past the 500-issue cap; silently truncates.
- Commit style: imperative subject, body explains why, `Co-Authored-By: Claude <model> <noreply@anthropic.com>`; typecheck+build before committing; push to origin main after committing.
