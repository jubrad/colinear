# `:tasks` — the task table

Aliases: `ls`, `t`. The same tasks as the [board](board.md), as one list — for when there are more
cards than a column can show.

```
tasks[6/6] sorted by board ↑                                                                           / filter · , sort
ISSUE      STATUS      TITLE                                        REPO      PR              CI       TIME   TOKENS
CLO-142    queued      Add a rollback path for the schema migration cloud                              7:00   27k
CLO-140    working     Retry sync-server writes on 429              cloud                              7:00   27k
CLO-138    needs input Decide auth for /v2/sync                     cloud                              7:00   27k
SAS-91     pr open     Emit metering events per tenant              cloud     #1204 approved  passing  7:00   27k
1–4 of 6
```

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
