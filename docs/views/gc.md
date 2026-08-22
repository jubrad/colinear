# `:gc` — reclaim disk and finished cards

Alias: `disk`. Two resources, one question — *what here is over?* A worktree is a full checkout, and
one accumulates per task and per PR reviewed; a finished card keeps its row on the board until
retention forgets it a month later. This is how you get both back on demand.

| key | what |
|---|---|
| `space` | pick one · `a` all · `n` none |
| `+` / `-` | change how long finished work is kept (`worktreeRetentionDays`, 7 days by default) |
| `x` | remove what's picked — with per-worktree progress, because a 60 GB tree isn't instant |
| `r` | rescan |

The `KIND` column says which resource a row is:

- **`tree`** — a worktree on disk: **finished tasks** past the keep window, **review checkouts**
  whose review has gone stale (the PR merged, closed, or someone else took it), and **orphans**,
  directories no task claims, left behind by repo re-routes or removed tasks.
- **`task`** / **`review`** — a **finished card**: a task that is done or cancelled, or a review
  that has settled (merged or closed away, or one you submitted — commented, approved, changes
  requested). These are the same states the `retentionDays` sweep eventually forgets on its own;
  `:gc` is how you say "now" instead of waiting out the window.

Forgetting a card removes it from colinear and nothing else: the tracker issue, the PR, the branch
and the commits are all untouched, and a task whose issue is still open comes back the next time you
dispatch it. Worktrees go first and cards second, so a card is never forgotten out from under the
scan that is still deciding what its directory belongs to.

Nothing live is ever listed — no agent, no pending question, no review still in play — and removing
a worktree leaves its branch and commits in the repo. If the task list fails to load, colinear
refuses to call anything an orphan rather than guessing.

The same disk pass works from a shell, with the daemon down:

```bash
coli gc                      # print what could go, remove nothing
coli gc --yes                # do it
coli gc --older-than 30      # a different keep window for this run
```

It lists finished cards too, but never forgets them: the command edits no board state, and a running
daemon owns `state.json` — writing it from underneath would lose whichever copy saved second. Use
`:gc` for those.
