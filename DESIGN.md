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
                     claude/shell/editor); `daemon [status|stop]` runs/controls the backend
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
  config.ts          ~/.config/colinear/config.json (legacy ~/.colinear.json), repos allowlist
                     normalization (remote/pushRemote/prBase are GIT REMOTE NAMES), --team flag
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
                     relays the human answer via a deny message (hack; SDK "defer" would be cleaner),
                     usage/token accounting, structured output via outputFormat json_schema, resume/abort
  linear.ts          GraphQL client; queryIssuesPaged (cursor pagination, 500 cap) backs all issue
                     fetches; teams/projects/viewer/labels; mutations (create/assign/state/comment);
                     fetchBlockers (inverseRelations type "blocks")
  prs.ts             gh pr list per repo w/ tasks; matching: pinnedPr > branch match > identifier in
                     head/title, ranked OPEN > MERGED > CLOSED; stack chaining by baseRef; status
                     transitions (incl. un-failing error tasks that gain a live PR); CI babysitter
  statesync.ts       Linear state moves (dispatch→started, first PR→In Review), per-team state cache
  persist.ts         state.json v2: tasks (minus live question fn) + planner snapshots + UI prefs;
                     debounced on store change + 10s heartbeat + flush on exit; atomic tmp+rename;
                     live statuses restore as `interrupted`
  planner.ts         :plan chat — long-lived SDK session (streaming input via AsyncIterable),
                     read-only (denies Write/Edit), parses ```json subtasks fence into drafts,
                     approve() creates Linear sub-issues; snapshot/restore for persistence
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
src/views/           registry.ts maps names/aliases → components + hotkey help; issues/board/task/
                     projects/project/plan/config/help; custom views wrap IssuesView with a spec
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

## Task lifecycle

`queued → triage → working → checks → done|pr_open` with detours:
- `blocked` (Linear blockers open; rechecked every 60s + on merges/completions)
- `needs_input` (agent AskUserQuestion, or too_big/needs_info triage verdicts — split-plan review lives here)
- `interrupted` (restart/suspend/attach; `r` resumes the SDK session by id)
- `error` (failures; auto-unfails if a live PR turns up), `escalated` (legacy; verdicts now park as needs_input)
- fixci mode: red PR rollup → resume session with failing logs, one attempt per red, re-arms on green

Sessions are Claude Code sessions keyed by worktree cwd (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). colinear stores only the session id + worktree; interactive attach (`claude --resume`) and headless resume share the same transcript.

## Prompts

All agent-facing text lives at the bottom of dispatcher.ts. `taskContext()` renders the shared context block (issue+description+parent, repo/remotes/branch, PRs with pin markers, triage verdict/plan, operator instructions) and heads every work/resume/fixci prompt. Invariants encoded in prompts: draft PRs only (`gh pr ready` forbidden — human presses `d`), adopt existing PRs (never duplicate), subtask checklist file `.colinear-subtasks.md` (git-excluded per worktree, polled every 2s onto the card), verification tiers, fork-workflow rules.

## Testing strategy

No unit tests (deliberate for now — UI-heavy, fast-moving). The verification loop is:

1. `npx tsc --noEmit` — must be clean before every commit. **Ignore editor/LSP diagnostics in this repo; they are chronically stale — trust tsc.**
2. `npm run build` — refreshes dist so the linked `coli` binary picks up changes.
3. `npm run check` — CDC replay: mirror must match the source store exactly.
4. Smoke boot: `LINEAR_API_KEY=lin_api_dummy script -q /dev/null timeout 5 npm run dev >/dev/null 2>&1; echo $?` → it rendered if you see board chrome. Note this now *starts a daemon* against your real config and state — `coli daemon stop` afterwards, and don't enqueue fake issues into a daemon holding live state.
5. Real verification is dogfooding against the live Linear workspace; `~/.local/state/colinear/colinear.log` catches runtime errors and diverted stderr (React warnings land there — check it when behavior is weird).

If adding tests someday: core/ is mostly pure-ish and dependency-injectable (store is a singleton — the main obstacle); prs.ts matching and dispatcher redispatch/adoption logic are the highest-value targets.

## Rendering gotchas (hard-won — do not relearn these)

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
| custom views | `~/.config/colinear/views/*.json` |
| task/planner/UI state | `~/.local/state/colinear/state.json` |
| debug log + diverted stderr | `~/.local/state/colinear/colinear.log` |
| attach scripts | `~/.local/state/colinear/attach-*.sh` |
| worktrees | `<repo>-worktrees/<ISSUE-KEY>` (per repo config) |
| session transcripts | `~/.claude/projects/<encoded-worktree>/<session>.jsonl` (Claude Code's, not ours) |

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
