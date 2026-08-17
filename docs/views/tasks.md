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
| `/` | filter — id, title, repo, status, PR state, CI |
| `,` | sort by column |
| everything else | identical to the [board](board.md#keys): `enter`, `a`, `m`, `M`, `u`, `s`, `S`, `x`, `r`, `f`, `b`, `c`, `o`, `O` |

The selected task's detail pane sits below the table when the terminal is tall enough.
