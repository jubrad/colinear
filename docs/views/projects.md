# `:projects` and `:project` — project views

`:projects` (aliases `pj`, `proj`) lists the tracker's projects: state, priority, progress, lead,
teams, target date. `/` filters, `t` switches team, `s` sorts, `enter` opens one.

`:project NAME` (alias `p`) is a kanban of that project's issues, whether or not they're dispatched.

## New projects (`n`)

`n` opens a template: the **team** it belongs to, the **state** it starts in (planned / started /
paused), its **priority**, and a **brief** — a paragraph-sized box where `enter` is a newline and
`ctrl-d` creates.

An agent turns the brief into the project: a name someone can read, the one line the list shows, and
a body covering the problem, what is in scope, what is explicitly not, and how anyone will know it
worked. It is told not to invent a schedule, owners, or an issue breakdown — issues get filed
separately, and [`:plan`](plan.md) is where a breakdown comes from.

The form asks only for the facts a model should not be guessing. Everything it can write, it writes.

While it writes, a progress popup streams the agent's activity and then holds the result — the
project's name (with `o` to open it in the tracker), or the failure — until you dismiss it. `esc`
mid-flight hides the popup without stopping the draft.

Demo mode runs no agent: the first line of the brief becomes the name and the rest becomes the body,
which is a plainer version of the same shape.

Needs a provider with the `createProjects` capability.

## Keys (`:projects`)

| key | what |
|---|---|
| `enter` | open the project's board |
| `n` | **new project** — the template above |
| `p` | the [planning chat](plan.md) for the project under the cursor |
| `/` filter · `t` team · `s` sort · `o` open in the tracker · `r` refresh |

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
