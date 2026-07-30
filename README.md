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
  "attachPermissionMode": "acceptEdits"
}
```

- `repos` — the allowlist. Agents only ever touch these repos, and only through worktrees under each repo's `worktreeRoot`; working copies are never modified (the main checkout only sees `git fetch` and `git worktree add`). First entry is the default; custom dispatch picks per dispatch. Per repo: `defaultBranch` (worktree base, default `main`), `remote` (the upstream: worktree base + the repo PRs land in, default `origin`), `pushRemote` (where branches are pushed — set your fork here for a fork workflow, e.g. `"jubrad"`; default = `remote`), `prBase` (PR target branch, default = `defaultBranch`), `checks` (run after the work pass). `remote`/`pushRemote` are **git remote names** as they appear in `git remote -v` for that repo (`"mz"`, `"jubrad"`), not `owner/repo` slugs. In fork mode agents skip stacked PRs (they'd require pushing to the upstream). Legacy single-repo fields (`repo`, `defaultBranch`, `worktreeRoot`, `checks`) still work.
- `description` (per repo) — what lives there. **Triage reads these to route each issue to the right repo** (it can inspect all allowlisted repos and returns its pick; the work pass starts there). Write them honestly.
- `model` — default model for agents; overridable per dispatch and per task (`m`).
- `tickMs` — UI refresh tick; raise if your terminal repaints non-atomically.
- `attachPermissionMode` — permission mode for `s` attach sessions: `acceptEdits` (default), `bypassPermissions`, or `default`.
- `stateSync` — auto-move Linear states (dispatch → In Progress, PR → In Review).
- `ciAutofix` — dispatch a fix session when a task's PR checks go red.
- `terminal` — session attach target: unset = in-place (recommended), `"ghostty"` / `"terminal"` = external window.
- `--team CLOUD` / `--team all` flags override the config; the last picker team is remembered across runs.

## Views (`:` to jump, tab completes; `:reload` refreshes custom views)

| view | what |
|---|---|
| `:issues [team\|all\|mine]` | sortable issue table (priority, parent link for sub-issues, labels, state, assignee); `/` fuzzy, `t` team (k9s-namespace style), `l` label, `s` sort by any column, `p` include/exclude project issues; `space` select, `enter` dispatch, `D` dispatch skipping triage, `c` custom dispatch (instructions + model + repo + triage modal), `n` **new issue from a description** (an agent drafts and files it), `o` open in Linear, `b` board. Queries paginate (500 cap); the default view shows non-project issues only |
| `:board` | kanban: Queued / Triage / Working / Needs Input / PR Open / Done / Failed; `j/l` move columns, `i/k` move cards (arrows too); cards show live duration, tokens, repo, subtask progress, CI + review state; `a`/`1-9` answer, `enter` task detail, `m` **edit task** (repo, pinned PR, instructions, model; `ctrl+r` requeues), `u` dispatch sub-issues (picker), `s` attach claude, `S` shell, `x` cancel, `r` resume, `c` post escalation to Linear, `o` open PR, `O` open issue, `n` issues |
| `:task CLOUD-123` | full detail: scrollable activity log (`j/k`, `g` top, `G` follow), subtasks, check output, PR overview (draft/state, CI, review decision, URL, stack base); `d` marks the draft PR ready — the only path out of draft |
| `:projects` / `:project NAME` | projects table (state, progress, lead, teams, target; `/` `t` `s` filters + sort) and per-project kanban; `d`/`c` dispatch, `p` planning chat |
| `:plan PROJECT` | persistent chat with a read-only planning agent; proposes subtasks as drafts — `space` toggle, `A` create in Linear, `D` create + dispatch |
| `:config` | resolved config (key masked), `e` to edit |
| `:help` (`?`) | all views, keys, custom view schema |

Global: `esc` clears filters then goes back, `q` back/quit, `ctrl+c` quit. Crumbs + toasts at the bottom; header shows agents/tokens/cost and per-view hotkeys. Board opens first when a previous run's tasks were restored.

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
