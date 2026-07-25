# foreman

Linear + Claude Code orchestrator TUI. Pick Linear issues, dispatch Claude Code agents (one git worktree each, subscription auth), watch a kanban board of triage/work/PR state, answer agent questions inline, escalate too-big issues back to Linear.

## Setup

```bash
npm install
```

Requirements:
- `claude` CLI logged in (subscription auth — no `ANTHROPIC_API_KEY` needed or wanted)
- `gh` CLI authenticated
- Linear API key (Settings → API → personal key)

Config at `~/.foreman.json`:

```json
{
  "linearApiKey": "lin_api_...",
  "repo": "~/work/cloud",
  "defaultBranch": "main",
  "worktreeRoot": "~/work/cloud-worktrees",
  "concurrency": 3,
  "team": "CLOUD",
  "checks": [
    { "name": "fmt", "cmd": "bin/fmt --check" }
  ]
}
```

`LINEAR_API_KEY` env var works instead of the config field.

## Run

```bash
npm run dev              # my assigned issues (or config "team" default)
npm run dev -- --team CLOUD
```

Flow: picker (space to select issues, enter to dispatch) → board. In the picker: `/` fuzzy/label search (`#label`), `t` switch team ("My issues" = assigned to me across teams; a team = all its active issues).

Per issue: worktree created off `origin/<defaultBranch>` → **triage pass** (read-only investigation, JSON verdict: `do` / `too_big` / `needs_info`) → **work pass** (implement, commit, push, `gh pr create`) → configured checks → PR polling (state, CI rollup, stacked PRs chained by base branch).

Board keys: arrows/hjkl select card, `a` answer a pending agent question (or 1-9 for offered options), `c` post escalation comment to Linear, `o` open PR in browser, tab toggles picker, `q` quits.

## Notes

- Agent questions (AskUserQuestion) pause the session until answered in the TUI; the answer is relayed via a permission-deny message, which the agent is told to treat as the user's reply.
- Concurrency default 3 — parallel sessions above ~5 hit rate limiting on subscription plans.
- Worktrees are left in place for inspection; clean up with `git worktree remove` / `git worktree prune`.
