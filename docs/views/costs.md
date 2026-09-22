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

## Which model ran it

Each row names the models that actually ran it, which is no longer one answer: models are chosen
per kind of session, so a task's triage can run on a different model from its work, and a session
that runs out of allowance finishes on whatever it demoted to. The row lists what actually ran,
in the order it ran, not what the config asked for.

That comes from a per-session ledger kept on each task and review. A row's total is the sum of its
ledger, written in the same change so the two cannot drift apart.

## Runs with no price

A run whose runtime reports no price shows `--` rather than `$0.00`, and the header says how many
sessions are unpriced. The distinction is load-bearing: counting an unpriced run as free would
leave the total looking authoritative while being too small. Tokens are always reported, so they
are the measure that works everywhere.
