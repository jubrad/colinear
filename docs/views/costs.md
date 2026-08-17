# `:costs` — spend

Aliases: `cost`, `$`. A live bar chart of what each task and PR review has cost, sorted by cost.

| key | what |
|---|---|
| `s` | cycle sort: cost / tokens / most recent |
| `/` | fuzzy filter |
| `enter` | task detail |

Bars are coloured by task status. The window matches `retentionDays`, so the chart and the board
agree about what still exists.

**The figures are what the work would cost on the API.** Subscription runs aren't billed per token —
treat them as a relative measure of how expensive an agent's approach was, not an invoice.
