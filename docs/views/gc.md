# `:gc` — reclaim worktree disk

Alias: `disk`. A worktree is a full checkout, and one accumulates per task and per PR reviewed. This
is how you get the space back.

| key | what |
|---|---|
| `space` | pick one · `a` all · `n` none |
| `+` / `-` | change how long finished work is kept (`worktreeRetentionDays`, 7 days by default) |
| `x` | remove what's picked — with per-worktree progress, because a 60 GB tree isn't instant |
| `r` | rescan |

Three things are offered: worktrees of **finished tasks** past the keep window, **review checkouts**
whose review has gone stale (the PR merged, closed, or someone else took it), and **orphans** —
directories no task claims, left behind by repo re-routes or removed tasks.

Nothing live is ever listed, and branches and commits stay in the repo — only the checkout goes. If
the task list fails to load, colinear refuses to call anything an orphan rather than guessing.

The same thing works from a shell, with the daemon down:

```bash
coli gc                      # print what could go, remove nothing
coli gc --yes                # do it
coli gc --older-than 30      # a different keep window for this run
```
