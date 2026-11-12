# `:jobs` — work you ask colinear for directly

Aliases: `job`, `j`, `cron`. Optional argument: a job's name, to open with it selected.

A job is work with no tracker issue or PR behind it, for example:

- "review the dependabot PRs and approve the clean ones";
- "summarise my GitHub activity this week";
- "make sure every piece of console feedback in #feedback has a Linear issue".

You run a job by hand with `r`, or the daemon runs it on a cron schedule. Each run ends with a
report, which is what you open the job to read.

```
  JOB                     NEXT      LAST RUN                       ┌──────────────────────────────────────────────┐
✓ dependabot sweep        in 3h     25h ago · approved 1 of 2 …    │ dependabot sweep 0 9 * * 1-5                  │
  my week on github       in 2d     never run                      │ next 11/12/2026, 9:00 AM · default model      │
✖ console feedback triage by hand   10m ago · no Slack tools …     │ may review, approve                           │
                                                                   │ ✓ ok · run 1 of 1 · scheduled · 26h ago · 12m │
                                                                   │ approved 1 of 2 dependabot PRs                │
                                                                   │ through colinear:                             │
                                                                   │   approved cloud#901                          │
                                                                   │                                               │
                                                                   │ ## Dependabot sweep                           │
                                                                   │ - cloud#901 bump serde — clean, approved      │
                                                                   │ - cloud#902 bump tokio — 2 findings, held     │
                                                                   └───────────────────────────────────────────────┘
```

| key | what |
|---|---|
| `j` `k` / ↑ ↓ | move · `g` top · `G` bottom |
| `n` | new job |
| `e` | edit the selected job |
| `r` | run it now |
| `x` | stop the run in flight |
| `enter` | move into the report to scroll it (`j`/`k`, `space` a page) · `esc` back |
| `[` `]` | older / newer run (it keeps the last 20) |
| `p` | pause the schedule, or resume it — the schedule is kept |
| `D` | delete it and its runs (press twice) |

A running job is also in [`:agents`](agents.md) with the other sessions. `enter` there brings you
back here.

## What a job may do

Each job has its own security profile, set in the form, and a new job starts with nothing granted.
It can read and report, and nothing else, until you grant more:

| row | what it grants |
|---|---|
| `review` | `review_pr`: runs colinear's [pre-review](reviews.md) of a pull request and returns its findings. A PR already reviewed at its current head isn't reviewed again. Reads only. |
| `approve` | `approve_pr`: submits an approval through colinear, using the same deterministic post as `a` in `:reviews`. **Refused** unless the PR has a finished colinear review of its current head with no finding that asks for a change (blocking, consider, comment or nit; praise and annotations are fine). |
| `comment` | `comment_pr`: posts a review's findings to the PR as comments, the same as `p` in `:reviews`. |
| `user tools` | loads your user-level Claude settings into the session, which brings your own MCP servers with them. This is how a job gets Slack or Linear: connect those MCP servers in your Claude settings, then turn this on for the job. |
| `mode` | the permission mode for its session. The default is the config's `agentPermissionMode`. Nobody is there to approve a prompt, so anything the mode would have asked about is refused. |
| `deny` | tools refused on top of the config's `denyTools`, using the same patterns: `Bash(git push:*), WebFetch`. |

An action you didn't grant isn't refused when called: the tool simply doesn't exist in that job's
session. Every action a run takes is recorded on the run, under *through colinear*, so you can see
exactly what reached GitHub.

Actions go through colinear rather than the agent's own `gh` because colinear records them and
posts deterministically. That's why approving takes a colinear review first: the job can't approve
anything colinear hasn't read.

## Schedules

The form takes a cron expression (minute, hour, day of month, month, weekday). It shows when the
expression next fires as you type, and refuses one that doesn't parse:

| schedule | runs |
|---|---|
| *(blank)* | only when you press `r` |
| `0 9 * * 1-5` | 9:00 on weekdays |
| `*/30 * * * *` | every half hour |
| `0 17 * * 5` | Fridays at 17:00 |

The daemon checks every 30 seconds. A run missed while the daemon was down happens once, as soon
as it's back, not once per miss. A job never overlaps itself: a run that's still going when the
next one is due is skipped.

## How it runs

A job's session runs in its own scratch directory under colinear's state directory. It isn't in
one of your checkouts; `review_pr` checks out what it reviews the same way `:reviews` does. Jobs
use the `job` model unless the job names one ([configuration](../configuration.md)). It's told
nobody is watching: it doesn't ask questions, it makes the conservative call and says so in the
report. Colinear's actions need a Claude model; a job on another runtime can still read and report.
