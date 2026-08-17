# colinear

A k9s-style terminal UI that runs Claude Code agents against your issue tracker. Pick issues, dispatch an agent per issue into its own git worktree, and watch a live board of what they're doing — questions answered inline, draft PRs, CI, review state, cost.

It runs on **Claude subscription auth** (the logged-in `claude` CLI), works on **Linear** today behind a provider interface, and never touches your working copy: agents get worktrees, and they only ever open draft PRs.

```
Queued(1)        Triage(0)        Working(1)       Needs Input(1)   PR Open(2) 1-1   Failed(0)        Done(1) 1
╔══════════════╗                  ╭──────────────╮ ╭──────────────╮ ╭──────────────╮                  ╭──────────────╮
║ CLO-142 Add  ║                  │ ⠴ CLO-140    │ │ CLO-138      │ │ SAS-91 Emit  │                  │ CLO-131 Dro… │
║ a rollback   ║                  │ Retry        │ │ Decide auth  │ │ metering     │                  │ ✓ merged #1… │
║ 7:00 · 27k … ║                  │ 7:00 · 27k … │ │ 7:00 · 27k … │ │ 7:00 · 27k … │                  ╰──────────────╯
║ pushing the… ║                  │ ▰▰▰▰▱▱▱▱ 1/2 │ │ ? Which mec… │ │ pushing the… │
╚══════════════╝                  │ pushing the… │ ╰──────────────╯ │ #1204 open … │
                                  ╰──────────────╯                  ╰──────────────╯
                                                                    ▼ 1 more — i/k …
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ CLO-142: Add a rollback path for the schema migration 7:00 · 24k in · 3k out · $1.20                                 │
│ ── activity ──                                                                                                       │
│ pushing the branch                                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Every task is also a searchable, sortable table — same data, same keys, `:tasks`:

```
tasks[6/6] sorted by board ↑                                                                           / filter · , sort
ISSUE      STATUS      TITLE                                        REPO      PR              CI       TIME   TOKENS
CLO-142    queued      Add a rollback path for the schema migration cloud                              7:00   27k
CLO-140    working     Retry sync-server writes on 429              cloud                              7:00   27k
CLO-138    needs input Decide auth for /v2/sync                     cloud                              7:00   27k
SAS-91     pr open     Emit metering events per tenant              cloud     #1204 approved  passing  7:00   27k
1–4 of 6
```

## Quick start

```bash
git clone https://github.com/jubrad/colinear && cd colinear
npm install && npm link          # installs `coli` on PATH
coli init                        # tracker, key, repos — or `coli init --yes` to infer them
npm run doctor                   # claude CLI, gh auth, key, repos
coli                             # `?` for help, `:` to jump between views
```

Requirements: the `claude` CLI logged in (leave `ANTHROPIC_API_KEY` unset), `gh` authenticated, and a Linear API key.

## What it does

- **Dispatch** — an agent per issue, in a worktree cut from your repo. Triage picks the repo and scopes the work, the work pass implements it and opens a **draft** PR. Agents never mark a PR ready; that's your keypress.
- **Watch** — a kanban board and a table view of every task: live duration, tokens, cost, subtask progress, CI and review state, blocked-by chains.
- **Steer** — answer an agent's questions in a form, message a running agent without attaching, attach to its session and hand it back, cancel, resume, rebase.
- **Review** — PRs awaiting your review get an assisted pre-review you edit and post deterministically, never by an agent.
- **Plan** — a read-only planning chat that drafts sub-issues for you to approve.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | install, configure, first dispatch |
| [Security & blast radius](docs/security.md) | what it can touch, what it can't, where your data goes |
| [How dispatch works](docs/dispatch.md) | triage → work → checks, messaging agents, sessions |
| [Configuration](docs/configuration.md) | every option, with defaults |
| [Remote daemon](docs/remote.md) · [Docker](docs/docker.md) | run the daemon on a VM or in a container *(work in progress)* |
| [CLI](docs/cli.md) | `coli`, `init`, `daemon`, `gc`, `contexts` |
| [Views](docs/views/) | one page per view — `:board`, `:issues`, `:reviews`, … |
| [Architecture](DESIGN.md) | how it works inside, and the gotchas |

## Status

Used daily by its author against a real Linear workspace; APIs and keybindings still move. Linear is the only issue provider today — [the interface and its capability flags](docs/configuration.md#issue-providers) are what a second one plugs into.

MIT licensed.
