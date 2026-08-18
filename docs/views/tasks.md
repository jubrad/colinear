# `:tasks` — the task table

Aliases: `ls`, `t`. The same tasks as the [board](board.md), as one list — for when there are more
cards than a column can show.

![The task table sorted in board order, the cursor on a PR-open task whose detail pane sits below](../images/tasks.png)

Default order is the board read left-to-right: column, then what needs you first. `,` sorts by any
column (again on the same one reverses), `/` filters with the same matcher the board uses.

## Keys

| key | what |
|---|---|
| `j` `k` / ↑ ↓ | move · `g` top · `G` bottom |
| `/` | filter — id, title, repo, status, PR state, CI; `parent:CAD-12` or `parent:cadence` for everything under one issue or project |
| `,` | sort by column |
| everything else | identical to the [board](board.md#keys): `enter`, `a`, `m`, `M`, `u`, `s`, `S`, `x`, `r`, `f`, `b`, `c`, `o`, `O` |

The selected task's detail pane sits below the table when the terminal is tall enough.

`parent:` is the same token [`:issues`](issues.md) uses, and means the same thing: what is this part
of — the issue above it, or its project. A bare `/CAD-12` still finds CAD-12 itself rather than its
children, because searching for an id should find that id.
