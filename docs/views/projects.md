# `:projects` and `:project` — project views

`:projects` (aliases `pj`, `proj`) lists the tracker's projects: state, progress, lead, teams, target
date. `/` filters, `t` switches team, `s` sorts, `enter` opens one.

`:project NAME` (alias `p`) is a kanban of that project's issues, whether or not they're dispatched.

## Keys (`:project`)

| key | what |
|---|---|
| `h/l` `j/k` / arrows | move between issues |
| `space` | select |
| `d` dispatch · `D` dispatch skipping triage · `c` custom dispatch |
| `p` | open the [planning chat](plan.md) for this project |
| `M` | the project's [coordination channel](chan.md) — one message to every agent working an issue in it (experimental) |
| `enter` | task detail, for issues already dispatched |
| `o` open in the tracker · `r` refresh |

Both views need a provider with the `projects` capability; one without says so rather than showing an
empty table.
