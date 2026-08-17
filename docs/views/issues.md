# `:issues` — browse and dispatch

Aliases: `i`, `is`. Argument: a team key, `all`, or `mine` (`:issues CLOUD`).

The tracker's issues as a sortable table — id, parent link for sub-issues, priority, title, labels,
state, assignee. Issues already on the board are filtered out, so what you see is what you could
still dispatch.

## Keys

| key | what |
|---|---|
| `/` | fuzzy filter. `#bug` or `label:bug` filters by label |
| `t` | switch team (the provider's word for it — team, project, repo) |
| `l` | add a label filter · `s` sort by any column · `p` include/exclude project issues |
| `space` | select — actions apply to the selection, or to the row under the cursor |
| `enter` | **dispatch** |
| `D` | dispatch, skipping triage |
| `c` | custom dispatch: instructions, model, repo, whether to triage |
| `n` | **new issue from a description** — an agent drafts the title and body and files it |
| `o` | open in the tracker · `b` board · `r` refresh |

## Notes

- Dispatching self-assigns the issue and moves it to In Progress immediately (`stateSync`), not when
  an agent slot frees up.
- Issues with unresolved blocking relations park as ⛓ blocked in the Queued column and start
  automatically when their blockers finish. `f` on the board starts one anyway, keeping the blockers
  as merge-order dependencies.
- Queries paginate with a 500-issue cap; the default view hides project issues (`p` shows them).
- Custom views are saved filters that render in this same table — see
  [configuration](../configuration.md#custom-views).
