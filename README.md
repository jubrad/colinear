# colinear

A k9s-style TUI that runs Claude Code agents against Linear. Browse issues, dispatch agents (one git worktree each, subscription auth), watch a live kanban board, answer agent questions inline, plan projects in a chat that drafts subtask issues, and track draft PRs / stacks / CI — without leaving the terminal.

## Install

```bash
npm install
npm run doctor    # checks claude CLI, gh auth, Linear key, repo
npm run dev       # or: npm run build && ./dist/index.js
```

Requirements: `claude` CLI logged in (subscription auth — leave `ANTHROPIC_API_KEY` unset), `gh` authenticated, Linear personal API key.

## Config

`~/.config/colinear/config.json` (or legacy `~/.colinear.json`); `LINEAR_API_KEY` env var works too:

```json
{
  "linearApiKey": "lin_api_...",
  "repos": [
    {
      "name": "cloud",
      "path": "~/work/cloud",
      "defaultBranch": "main",
      "worktreeRoot": "~/work/cloud-worktrees",
      "checks": [{ "name": "fmt", "cmd": "bin/fmt --check" }]
    },
    { "name": "materialize", "path": "~/work/materialize" }
  ],
  "concurrency": 3,
  "team": "CLOUD",
  "notifications": true,
  "stateSync": true,
  "ciAutofix": true
}
```

`repos` is the allowlist: agents only ever touch these repos, and only through worktrees under each repo's `worktreeRoot` — your working copies are never modified (the main checkout only sees `git fetch` and `git worktree add`). The first entry is the default; custom dispatch (`c`) picks the repo per dispatch. Legacy single-repo fields (`repo`, `defaultBranch`, `worktreeRoot`, `checks`) still work. View and edit the live config with `:config` (`e` opens $EDITOR, changes hot-apply).

`--team CLOUD` / `--team all` flags override the config.

## Views (`:` to jump, tab completes)

| view | what |
|---|---|
| `:issues [team\|all\|mine]` | sortable issue table; `/` fuzzy, `t` team, `l` label, `s` sort by any column; space+enter dispatches (self-assigns) |
| `:board` | kanban of agents: Queued/Triage/Working/Needs Input/PR Open/Done/Escalated; live duration, tokens, subtask progress |
| `:task CLOUD-123` | full task detail: scrollable activity log, checks, PR stack; `x` cancel, `r` resume, `d` PR ready |
| `:projects` / `:project NAME` | project list and per-project kanban; `d` dispatch, `p` planning chat |
| `:plan PROJECT` | chat with a read-only planning agent; approve drafted subtasks into Linear (`A`), or approve + dispatch (`D`) |
| `:help` (`?`) | all views, keys, custom view schema |

Global: `esc` clears filters then goes back, `q` back/quit, `ctrl+c` quit. Crumbs + toasts at the bottom, header shows agents/tokens/cost.

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

## How dispatch works

Per issue: worktree off `origin/<defaultBranch>` → triage pass (read-only; JSON verdict `do`/`too_big`/`needs_info` — escalations can be posted back to Linear with `c`) → work pass (subtask checklist file drives the card's progress bar; lints + tests before commit; subagent diff review; draft PR via `gh pr create --draft`) → configured checks → PR polling with stack chaining. Linear state auto-syncs (dispatch → started, PR → In Review) unless `stateSync: false`.

State persists in `~/.local/state/colinear/` — restart colinear and in-flight tasks come back as `interrupted`; `r` resumes the original session transcript. Rate-limited sessions retry once automatically. Agent questions pause the session and surface on the card/task view; answers are relayed back to the agent.

## Notes

- ~5+ concurrent sessions can hit subscription rate limits; default concurrency 3.
- Worktrees are left for inspection: `git worktree remove`/`prune` when done.
- Debug log: `~/.local/state/colinear/colinear.log`.
