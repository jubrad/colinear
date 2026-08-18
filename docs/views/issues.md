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
| `S` | sub-issues on/off — pull in the children of the issues listed, under their parents |
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
- **Sub-issues are usually missing for reasons that have nothing to do with being sub-issues.** They
  inherit their parent's project (hidden unless `p`), or they belong to whoever picked them up
  (hidden in the default `mine` view). `S` asks for them by parent instead of relaxing those
  filters, so the list keeps meaning what its header says: one extra query, children placed directly
  under the parent they belong to, and a `↳ PARENT` in the parent column. A child whose parent isn't
  in the list stays where the sort put it. Providers without sub-issues
  (`capabilities.subIssues`) ignore the key.
- Custom views are saved filters that render in this same table — see
  [configuration](../configuration.md#custom-views).
