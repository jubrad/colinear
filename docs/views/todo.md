# `:todo` — what to do next

Aliases: `next`, `agenda`, `recs`. No argument.

On by default. `"todo": false` in the config switches it off, along with its ranking agent and
refresh clock. See [configuration](../configuration.md#todo).

One ranked list of everything that is waiting on **you**: pull requests awaiting your review,
agents stopped on a question or a finished draft, your own issues, milestones several of them are
racing, and projects you lead with a date coming up. Each is reduced to the same shape, scored by
colinear, then put in order by an agent weighing review turnaround, deadlines and priority.

```
todo 9 of 23 · ranked by the agent 4m ago · $0.02
Clear the two overdue reviews first; the Beta milestone is Friday, so CLO-212 is next.

  WHEN   KIND      REF             NEXT                          WHAT
  now    task      CLO-203         Answer the agent              Retry backoff for the webhook sink
  now    review    cloud#13251     Review it                     Split the region config loader
  now    review    cadence#41      Review it                     Add the triage skill
  today  milestone GA              Check it will land            Beta · GA
  today  issue     CLO-212         Keep it moving                Cutover runbook
✓ today  task      CLO-198         agent on it                   Drop the legacy flag
  week   project   Beta            Check it will land on time    Beta
```

Under the list, the selected entry's reason, the facts it was ranked on, and its link.

| column | what |
|---|---|
| `WHEN` | `now` · `today` · `week` · `later` — how soon, rather than a score |
| `KIND` | `review` · `task` · `issue` · `milestone` · `project` |
| `REF` | the PR, issue, milestone or project |
| `NEXT` | the next move — or, once it has been dealt with, how |
| `WHAT` | its title |

## Keys

| key | what |
|---|---|
| `r` | rebuild the list and have the agent rank it |
| `b` | rebuild with colinear's own order only — no agent, no tokens |
| `x` | stop a ranking in progress, keeping colinear's order |
| `enter` | open it where it lives: the review, the task, the project. An issue with no task opens in the tracker |
| `o` | open its link in the browser |
| `h` | hide what has been handled since the list was made |

## Where the list comes from

`r` does two things, and the first lands before the second starts:

1. **Gather and score.** The daemon reads your open issues (project issues included), the tracker's
   projects, and a fresh copy of your review requests, then scores every candidate. That order is
   on screen within a second or two.
2. **Rank.** The best-scored candidates (60 by default) go to a ranking agent, which answers with an
   order, a next move and a one-sentence reason for each, plus a line on the shape of the day. It
   may leave things out. It can't add anything: it answers in keys colinear handed it, and a key it
   made up is dropped. What an entry points at, its facts and its link always come from colinear.

If the agent fails, or you stop it with `x`, colinear's own order stays and the error says so. A
tracker outage leaves you your reviews and tasks, with a line saying what could not be read, because
a short list and a complete one look the same otherwise.

Opening the view with no list builds colinear's order on its own. The agent only runs when you
press `r`, or on a clock if you set `todo.refreshMinutes`.

## What gets listed

| kind | listed when | not listed when |
|---|---|---|
| review | your review is requested, by name or through a team | you have posted, or the PR is settled |
| task | an agent asked a question, triage parked it, the session failed, the draft PR is green and ready to promote, changes were requested, CI stayed red after the automatic fix, a rebase didn't land, it is approved and unmerged, the coordinator proposed sub-issues, or it was interrupted | an agent has it, or the PR is waiting on other reviewers |
| issue | it is assigned to you, open, and has no live task | an agent is working it — the task stands in for it |
| milestone | two or more of your open issues share it and its date is within the horizon | only one issue is in it, since that issue carries the date |
| project | you lead it, it isn't done, and its target date is within the horizon | someone else leads it |

An issue and its task are never both on the list.

## How it weighs things

The default policy the agent is given, in brief:

- **Reviews are owed within about a working day.** The longer a request waits, the higher it goes.
  One past its turnaround outranks everything except an agent stopped on a question or an urgent,
  overdue deadline. The clock counts working hours from the latest request, so a re-request restarts
  it and a weekend doesn't age it. A **stale** PR stops climbing and sinks: a draft, or one untouched
  for `staleDays`.
- **Deadlines** come from the issue's due date, its milestone and its project, whichever is nearest.
  Overdue or due within a couple of days ranks high, and a date past the horizon counts for nothing.
- **Priority** is the issue's and its project's, from 1 (urgent) to 4 (low).
- **Agents waiting on you** are cheap to unblock and keep work moving, so they sit near the top. At
  equal weight, started work beats new work.

Colinear's own scoring follows the same rules, as a weighted sum.

| signal | score |
|---|---|
| review | 60 when asked, 110 at the SLA, 160 at twice it, then one more per working day up to 170. A team request is discounted by a fifth, and a stale one scores 5 |
| agent question | 180 |
| triage parked it | 110 |
| session failed | 100 |
| changes requested | 95 |
| draft ready to promote | 90 |
| issue priority | urgent 90 · high 65 · medium 40 · low 20 · none 30 |
| deadline | overdue +70 · within 2 days +55 · within a week +35 · within 2 weeks +20 · within the horizon +10 |
| issue started | +15 |

A task also carries half its issue's weight, so an urgent issue's failure outranks a low one's.

The policy is yours to replace, and the data and answer format around it are not, because those are
what colinear parses. See [configuration](../configuration.md#todo).

## Working down it

The list is a snapshot, but it ticks itself off. Each row is checked against live state by the rule
that listed it, so a review you posted reads *reviewed*, an answered question reads *agent on it*,
and a dispatched issue reads *dispatched*. Those rows go dim with a `✓`, and `h` hides them. Nothing
is re-ranked until you ask. A review going past its turnaround while you watch is the next list's
news.

The ranking agent appears in [`:agents`](agents.md) as kind `todo`, and its spend is on the
headline. It is denied every tool that could write, and reads nothing but its prompt. Pick its model
with `"model": { "todo": "sonnet" }`. The prompt carries every candidate, so a pass over 40 review
requests on the general model cost about $0.60 and took under a minute. A cheaper model is worth
naming before you set `todo.refreshMinutes`.
