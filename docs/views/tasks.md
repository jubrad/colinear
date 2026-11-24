# `:tasks` — the board as a list

Alias: `t`. No argument. Every task, laid out the way the board lays them out: column by column
(Queued, Triage, Working, Needs Input, PR Open, Failed, Done), each column opened by a header line
with its count. Every board key works on the selected row, and the selected task's detail pane
sits below the list when the terminal is tall enough.

```
Working 1
APP-1    tracking    - Add token-based login
APP-2    working     └ Document the token flow
APP-3    pr open     └ Issue tokens on login
PR Open 2
APP-9    pr open     Retry failed webhooks
```

**Parents and their sub-issues are drawn together**, the way [`:reviews`](reviews.md) draws a PR
stack. A tracking parent's sub-issues are listed under it, joined with `└` and a level deeper per
generation. They stay under their parent whatever their own column is, since each sub-issue's
`STATUS` says where it is. The parent's title starts with `-`, or with `+3` when its family is
folded. `z` on the parent or any of its sub-issues folds the family to the parent's line and back.
A sub-issue whose parent isn't shown, because it's filtered out or hidden as quiet, stands on its
own.

| key | what |
|---|---|
| `i` `k` / ↑ ↓ | move (headers are stepped over) · `g` top · `G` bottom |
| `z` | fold or open the family the cursor is in |
| `/` | filter: id, title, repo, status, PR state, CI, the matcher the board uses |
| `,` | sort: the [sort bar](../README.md#sorting). Any sort but the board's own drops the column headers and keeps the families together |
| `h` | show the tasks hidden as quiet: no session and no change to their work in [`hideStaleDays`](../configuration.md) (21 days by default). The header counts them; a running agent is never hidden |
| `t` | [`:agents`](agents.md): the same work grouped by whose move it is |
| everything else | identical to the [board](board.md#keys): `enter`, `a`, `M`, `s`, `S`, `r`, `f`, `v`, `b`, `x`, `o`, … |

`CHANGE` is [what the worktree has changed](board.md#what-it-has-changed): `+added -removed`, then
`~n` for files not committed yet. It turns amber when a working agent has edited nothing for twenty
minutes. `TIME` is how long the task has run, in days and hours past two days.
