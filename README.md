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
      "defaultBranch": "main",
      "remote": "origin",
      "prBase": "main",
      "worktreeRoot": "~/work/cloud-worktrees",
      "checks": [{ "name": "fmt", "cmd": "bin/fmt --check" }]
    },
    { "name": "materialize", "path": "~/work/materialize" }
  ],
  "concurrency": 3,
  "team": "CLOUD",
  "model": "sonnet",
  "notifications": true,
  "stateSync": true,
  "ciAutofix": true,
  "terminal": "ghostty"
}
```

- `repos` — the allowlist. Agents only ever touch these repos, and only through worktrees under each repo's `worktreeRoot`; working copies are never modified (the main checkout only sees `git fetch` and `git worktree add`). First entry is the default; custom dispatch picks per dispatch. Per repo: `defaultBranch` (worktree base, default `main`), `remote` (push target, default `origin`), `prBase` (PR target branch, default = `defaultBranch`), `checks` (run after the work pass). Legacy single-repo fields (`repo`, `defaultBranch`, `worktreeRoot`, `checks`) still work.
- `model` — default model for agents; overridable per dispatch.
- `stateSync` — auto-move Linear states (dispatch → In Progress, PR → In Review).
- `ciAutofix` — dispatch a fix session when a task's PR checks go red.
- `terminal` — session attach target: unset = in-place (recommended), `"ghostty"` / `"terminal"` = external window.
- `--team CLOUD` / `--team all` flags override the config; the last picker team is remembered across runs.

## Views (`:` to jump, tab completes; `:reload` refreshes custom views)

| view | what |
|---|---|
| `:issues [team\|all\|mine]` | sortable issue table (priority, labels, state, assignee); `/` fuzzy, `t` team (k9s-namespace style), `l` label, `s` sort by any column; `space` select, `enter` dispatch, `c` custom dispatch (instructions + model + repo modal), `o` open in Linear, `b` board |
| `:board` | kanban: Queued / Triage / Working / Needs Input / PR Open / Done / Failed; cards show live duration, tokens, subtask progress, CI + review state; `a`/`1-9` answer, `s` attach claude, `S` shell, `x` cancel, `r` resume, `c` post escalation to Linear, `o` open PR, `O` open issue |
| `:task CLOUD-123` | full detail: scrollable activity log (`j/k`, `g` top, `G` follow), subtasks, check output, PR overview (draft/state, CI, review decision, URL, stack base); `d` marks the draft PR ready — the only path out of draft |
| `:projects` / `:project NAME` | projects table (state, progress, lead, teams, target; `/` `t` `s` filters + sort) and per-project kanban; `d`/`c` dispatch, `p` planning chat |
| `:plan PROJECT` | persistent chat with a read-only planning agent; proposes subtasks as drafts — `space` toggle, `A` create in Linear, `D` create + dispatch |
| `:config` | resolved config (key masked), `e` to edit |
| `:help` (`?`) | all views, keys, custom view schema |

Global: `esc` clears filters then goes back, `q` back/quit, `ctrl+c` quit. Crumbs + toasts at the bottom; header shows agents/tokens/cost and per-view hotkeys. Board opens first when a previous run's tasks were restored.

## How dispatch works

Dispatching (enter, or `c` for the custom modal) immediately self-assigns the issue and moves it to In Progress, then per issue:

1. **Worktree** off `<remote>/<defaultBranch>` under the repo's `worktreeRoot`.
2. **Triage pass** (read-only): JSON verdict `do` / `too_big` / `needs_info` plus a **verification tier** — `local-light` (lints + unit tests), `ci` (agent confirms the CI config covers the change, then pushes the draft PR early and lets GitHub carry the heavy suites), or `needs-env` (contended local envs: verify what's possible, list the rest in the PR body). `too_big`/`needs_info` land in **Needs Input** for you to decide — `c` posts the proposed breakdown to Linear, `r` requeues after you act.
3. **Work pass**: subtask checklist file drives the card's progress bar; lints/tests per the verification tier; subagent diff review; push to the repo's `remote`; draft PR against `prBase` via `gh pr create --draft`. Agents may stack PRs (chained by base branch, rendered as a stack). **Agents never mark PRs ready** — that's your `d`.
4. **Checks** from the repo config, then PR polling: state, CI rollup, review decision (approved / changes requested / awaiting review). With `ciAutofix`, red checks dispatch a fix session (one per red rollup) that pulls the failing logs and pushes a fix.

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

- ~5+ concurrent sessions can hit subscription rate limits; default concurrency 3. Rate-limited sessions retry once after 30s.
- Worktrees are left for inspection: `git worktree remove`/`prune` when done — but removing one orphans its session (resume will start fresh).
- Debug log: `~/.local/state/colinear/colinear.log`.
