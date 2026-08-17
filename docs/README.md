# colinear docs

- **[Getting started](getting-started.md)** — install, configure, dispatch your first issue
- **[Security & blast radius](security.md)** — what colinear can touch, what it can't, where your data lives
- **[How dispatch works](dispatch.md)** — the triage → work → checks pipeline, messaging agents, sessions
- **[Configuration](configuration.md)** — every option and its default
- **[Remote daemon](remote.md)** — run the daemon on a VM, drive it over ssh
- **[CLI](cli.md)** — `coli`, `init`, `daemon`, `gc`, `contexts`, `doctor`
- **[Architecture](../DESIGN.md)** — how it works inside

## Views

`:` opens the command bar; tab completes. Most views also have a short alias.

| view | what it's for |
|---|---|
| [`:issues`](views/issues.md) | browse the tracker and dispatch agents |
| [`:board`](views/board.md) | the kanban of everything running |
| [`:tasks`](views/tasks.md) | the same tasks as a searchable, sortable table |
| [`:task`](views/task.md) | one task in full: log, PRs, checks, plan review |
| [`:reviews`](views/reviews.md) | PRs awaiting your review, and assisted pre-review |
| [`:projects` / `:project`](views/projects.md) | project list and per-project board |
| [`:plan`](views/plan.md) | planning chat that drafts sub-issues |
| [`:costs`](views/costs.md) | spend per task and review |
| [`:gc`](views/gc.md) | reclaim worktree disk |
| [`:logs`](views/logs.md) | the live debug log |
| [`:chan`](views/chan.md) | coordination channels (experimental) |
| [`:config`](views/config.md) | resolved config, contexts, provider capabilities |
| [`:help`](views/help.md) | every view and key, in the app |

## Global keys

| key | what |
|---|---|
| `:` | command bar — a view name, optionally with an argument (`:task CLO-142`) |
| `?` | help |
| `esc` | clear filters, then go back |
| `q` | back, or quit at the root |
| `R` | reload the frontend on new code — agents keep running |
| `ctrl+c` | quit |
