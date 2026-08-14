# colinear

A k9s-style TUI that runs Claude Code agents against Linear. Browse issues, dispatch agents (one git worktree each, subscription auth), watch a live kanban board, answer agent questions inline, attach to any agent's session and hand it back, plan projects in a chat that drafts subtask issues, and track draft PRs / stacks / CI / review state — without leaving the terminal.

## Install

```bash
npm install
npm run doctor    # checks claude CLI, gh auth, Linear key, repo
npm link          # installs `coli` + `colinear` on PATH (builds dist)
coli              # or: npm run dev
```

Requirements: `claude` CLI logged in (subscription auth — leave `ANTHROPIC_API_KEY` unset), `gh` authenticated, Linear personal API key. Optional: `brew install terminal-notifier` makes notifications click through to the PR/issue.

## Config

`~/.config/colinear/config.json` (or legacy `~/.colinear.json`); `LINEAR_API_KEY` env var works too. View and edit live with `:config` (`e` opens $EDITOR — seeds the file from current settings on first use; changes hot-apply on return).

```json
{
  "linearApiKey": "lin_api_...",
  "repos": [
    {
      "name": "cloud",
      "path": "~/work/cloud",
      "description": "Materialize Cloud control plane: controllers, sync-server, Pulumi infra",
      "defaultBranch": "main",
      "worktreeRoot": "~/work/cloud-worktrees",
      "checks": [{ "name": "fmt", "cmd": "bin/fmt --check" }]
    },
    { "name": "materialize", "path": "~/work/materialize", "pushRemote": "jubrad" }
  ],
  "concurrency": 3,
  "team": "CLOUD",
  "model": "sonnet",
  "notifications": true,
  "stateSync": true,
  "ciAutofix": true,
  "terminal": "ghostty",
  "tickMs": 1000,
  "attachPermissionMode": "auto",
  "guidance": [
    "PRs should solve the problem at hand simply and clearly.",
    "Code is debt: don't write code that isn't needed to solve and validate the problem."
  ]
}
```

- `repos` — the allowlist. Agents only ever touch these repos, and only through worktrees under each repo's `worktreeRoot`; working copies are never modified (the main checkout only sees `git fetch` and `git worktree add`). First entry is the default; custom dispatch picks per dispatch. Per repo: `defaultBranch` (worktree base, default `main`), `remote` (the upstream: worktree base + the repo PRs land in, default `origin`), `pushRemote` (where branches are pushed — set your fork here for a fork workflow, e.g. `"jubrad"`; default = `remote`), `prBase` (PR target branch, default = `defaultBranch`), `checks` (run after the work pass). `remote`/`pushRemote` are **git remote names** as they appear in `git remote -v` for that repo (`"mz"`, `"jubrad"`), not `owner/repo` slugs. In fork mode agents skip stacked PRs (they'd require pushing to the upstream). Legacy single-repo fields (`repo`, `defaultBranch`, `worktreeRoot`, `checks`) still work.
- `description` (per repo) — what lives there. **Triage reads these to route each issue to the right repo** (it can inspect all allowlisted repos and returns its pick; the work pass starts there). Write them honestly.
- `model` — default model for agents; overridable per dispatch and per task (`m`).
- `guidance` — standing house rules for agents. Either one block (a string or list of lines) that reaches every agent, or a map of scopes:

  ```json
  "guidance": {
    "general": ["applies to every agent"],
    "triage": "scoping an issue",
    "work":   "implementing an issue",
    "review": "reviewing someone else's PR",
    "plan":   "project planning chat"
  }
  ```

  Scoped text is **added to** `general`, not a replacement, so house rules only need saying once. Per-task instructions (`m`) outrank all of it, and repo-specific conventions still belong in each repo's `CLAUDE.md`.
- `tickMs` — UI refresh tick; raise if your terminal repaints non-atomically.
- `attachPermissionMode` — permission mode for `s` attach sessions: `auto` (default — classifier gates risky commands), `acceptEdits`, `bypassPermissions`, or `default`. Headless agents always run in `auto`; classifier-blocked commands surface on the board as needs-input questions (allow/deny).
- `stateSync` — auto-move Linear states (dispatch → In Progress, PR → In Review).
- `ciAutofix` — dispatch a fix session when a task's PR checks go red.
- `terminal` — session attach target: unset = in-place (recommended), `"ghostty"` / `"terminal"` = external window.
- `--team CLOUD` / `--team all` flags override the config; the last picker team is remembered across runs.

## Daemon

`coli` is two processes: a **daemon** that owns the dispatcher, the task store, persistence, PR polling and the Linear sweeps, and a **TUI** that mirrors its state over a unix socket (`~/.local/state/colinear/coli.sock`). Running `coli` starts both — the daemon only if one isn't already up.

Agents therefore outlive the UI. Close the terminal, quit with `q`, or hit `R` to restart the frontend on a fresh build; the daemon keeps working and the board reattaches to live state. The mirror is kept current by change data capture: the client hydrates from a snapshot and follows a versioned delta stream, re-snapshotting if it ever misses one.

| command | what |
|---|---|
| `coli` | TUI (starts a daemon if needed) |
| `coli daemon` | run the daemon in the foreground |
| `coli daemon status` | pid + socket, or "no daemon running" |
| `coli daemon stop` | stop it — live agents abort and resume with `r` |

Only the daemon dispatches agents, so stopping it is the one thing that interrupts work.

## Views (`:` to jump, tab completes; `:reload` refreshes custom views)

| view | what |
|---|---|
| `:issues [team\|all\|mine]` | sortable issue table (priority, parent link for sub-issues, labels, state, assignee); `/` fuzzy, `t` team (k9s-namespace style), `l` label, `s` sort by any column, `p` include/exclude project issues; `space` select, `enter` dispatch, `D` dispatch skipping triage, `c` custom dispatch (instructions + model + repo + triage modal), `n` **new issue from a description** (an agent drafts and files it), `o` open in Linear, `b` board. Queries paginate (500 cap); the default view shows non-project issues only |
| `:board` | kanban: Queued / Triage / Working / Needs Input / PR Open / Done / Failed; `j/l` move columns, `i/k` move cards (arrows too); cards show live duration, tokens, repo, subtask progress, CI + review state; `a`/`1-9` answer, `enter` task detail, `m` **edit task** (repo, pinned PR, instructions, model; `ctrl+r` requeues), `u` dispatch sub-issues (picker), `s` attach claude, `S` shell, `x` cancel, `r` resume, `c` post escalation to Linear, `o` open PR, `O` open issue, `n` issues |
| `:task CLOUD-123` | full detail: scrollable activity log (`j/k`, `g` top, `G` follow), subtasks, check output, PR overview (draft/state, CI, review decision, URL, stack base); `d` marks the draft PR ready — the only path out of draft |
| `:projects` / `:project NAME` | projects table (state, progress, lead, teams, target; `/` `t` `s` filters + sort) and per-project kanban; `d`/`c` dispatch, `p` planning chat |
| `:plan PROJECT` | persistent chat with a read-only planning agent; proposes subtasks as drafts — `space` toggle, `A` create in Linear, `D` create + dispatch |
| `:reviews` (`pr`) | PRs waiting on **your** review (`gh search prs --review-requested=@me`, all repos your gh auth can see). `r` starts an **assisted pre-review**: colinear checks the PR out in a worktree and an agent reads the diff in context, returning an overview plus findings; progress streams onto the card while it works. Nothing is posted — `enter` opens the **review document** full-screen — the agent's write-up on one side, a **discussion** with that same agent on the other (`tab` switches, `j/k` scroll, `e` edits it in `$EDITOR`). It goes both ways: your turn resumes the reviewing session so the PR is still in context, and when the agent needs a decision it asks in the same pane — answer inline, or press the option number. `p` posts it as one GitHub review — **deterministically**, since the findings are already structured: colinear clears any leftover pending review, then makes the `gh api` call itself, so posting costs no tokens and either works or says why. **Only the findings are posted** — one inline comment each. The first finding is the *lead*: no file, no line, no severity, one sentence, and it opens the review body, followed by a count of what was raised (`1 must fix / 3 considerations / 1 nit`) and an `## Other` section for anything with no line to attach to. The document's prose is written for you, to decide what to send, and never leaves your machine; the review body carries only what can't be a comment (findings with no line, your note, or a one-line summary when nothing anchored). `A` approves and `X` requests changes, sending the same review with that event, `n` attaches a note that rides along, `s` hands the terminal to that review's own claude session (suspending the agent first, as on the board), `o` opens the PR, `x` cancels a running review, `S` sorts (needs-me / updated / size / repo / author / cost — pressing it again on the same field reverses), `R` refreshes. Approve/request-changes are plain `gh` calls (no tokens) |
| `:costs` (`$`) | spend per run — tickets **and** PR reviews — live: a bar chart sorted by cost (`s` cycles cost/tokens/recent), `/` fuzzy filter, `enter` task detail. Bars are colored by task status. Figures are what the work *would* cost on the API — subscription runs are not billed per token |
| `:config` | resolved config (key masked), `e` to edit |
| `:help` (`?`) | all views, keys, custom view schema |

Global: `esc` clears filters then goes back, `q` back/quit, `R` reloads the frontend on new code (agents keep running), `ctrl+c` quit. Crumbs + toasts at the bottom; header shows agents/tokens/cost and per-view hotkeys. Board opens first when a previous run's tasks were restored.

## How dispatch works

Dispatching (enter, or `c` for the custom modal) immediately self-assigns the issue and moves it to In Progress. Issues with unresolved Linear **blocking relations** park as ⛓ blocked (shown in the Queued column) and start automatically when their blockers complete — checked every minute and whenever a colinear task finishes; `r` force-starts one. Then per issue:

1. **Worktree** off `<remote>/<defaultBranch>` under the repo's `worktreeRoot`. If the task has a pinned/open PR, the worktree checks out **that PR's branch** instead, and if any existing worktree already holds the branch, it's reused.
2. **Triage pass** (read-only): picks the **repo** the work belongs in (from the allowlist descriptions), a JSON verdict `do` / `too_big` / `needs_info`, and a **verification tier** — `local-light` (lints + unit tests), `ci` (agent confirms the CI config covers the change, then pushes the draft PR early and lets GitHub carry the heavy suites), or `needs-env` (contended local envs: verify what's possible, list the rest in the PR body). `too_big`/`needs_info` land in **Needs Input** for you to decide. For `too_big` the agent also returns a **split plan** — single-repo sub-issues with dependencies; entering the task lands in plan review: `space` to drop items, `A` to create them as Linear sub-issues (with `blocks` relations), `D` to create **and** dispatch (later, `u` on the parent card dispatches its sub-issues via a picker). `c` posts the breakdown to Linear as a comment instead; `r` requeues after you act. `D` at dispatch time (or the modal's triage field) skips triage entirely; re-dispatch keeps a successful triage plan unless you ask for a redo.
3. **Work pass**: every session opens with a full task-context block (issue + description, parent, repo/remotes, all PRs with pin markers, triage plan, your instructions). Existing PRs are **adopted** — the agent reviews their diff and pushes to their branch, never duplicates. Subtask checklist file drives the card's progress bar; lints/tests per the verification tier; subagent diff review; push to the repo's `pushRemote` (your fork, if configured); draft PR against `prBase` of the upstream via `gh pr create --draft`. Agents may stack PRs (chained by base branch, rendered as a stack). **Agents never mark PRs ready** — that's your `d`.
4. **Checks** from the repo config, then PR polling: state, CI rollup, review decision (approved / changes requested / awaiting review); matching prefers open/merged PRs over closed duplicates, and `m` can pin the canonical PR (number, `#123`, or URL) — a failed task that gains a live PR un-fails automatically. With `ciAutofix`, red checks dispatch a fix session (one per red rollup) that pulls the failing logs and pushes a fix.

## Sessions: attach, chat, background

`s` on any task hands your terminal to `claude --resume` in its worktree (a live agent is suspended first — never two writers in one worktree). Chat, steer, do work. Quit claude (`/exit`) and colinear asks **"resume agent in the background? [Y/n]"** — enter sends the conversation, including your interactive stint, back to a headless agent and returns you to the board. `S` opens a plain shell in the worktree without touching the agent.

Everything persists in `~/.local/state/colinear/`: tasks (status, session ids, PRs, activity), planner chats, UI prefs. Restart and in-flight tasks return as `interrupted` (`r` resumes the same transcript); planner chats resume their sessions too. Sessions are cwd-keyed by Claude Code, but colinear pins every session to its worktree path, so you can run `coli` from anywhere.

## Custom views

Drop JSON in `~/.config/colinear/views/`, then `:reload`:

```json
{
  "name": "cloud-bugs",
  "aliases": ["cb"],
  "describe": "unowned CLOUD bugs",
  "filter": { "team": "CLOUD", "labels": ["Bug"], "assignee": "any", "project": null },
  "columns": ["issue", "priority", "title", "labels"],
  "sort": "priority"
}
```

`filter`: `team`, `labels[]`, `state[]` (workflow types), `assignee` (`me`/`any`), `project` (`null` = no project, or a name).

## Notes

- Repos with multiple remotes need a gh default so PR polling/creation works non-interactively: `cd <repo> && gh repo set-default OWNER/REPO` (once per repo).
- ~5+ concurrent sessions can hit subscription rate limits; default concurrency 3. Rate-limited sessions retry once after 30s.
- Worktrees are left for inspection: `git worktree remove`/`prune` when done — but removing one orphans its session (resume will start fresh).
- Debug log: `~/.local/state/colinear/colinear.log`.
