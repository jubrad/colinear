# Demo mode

```bash
coli demo
```

A populated board with nothing behind it: **no Claude session, no git, no `gh`, no network, nothing
billed**. It writes a `demo` [context](configuration.md#contexts) — a local sqlite tracker with
`"demo": true` — and launches into it, so it can't touch your real config, state or repos.

## What you get

The fiction is **Cadence**, a team productivity and process-tracking app, mid-week with several
agents deep:

```
Queued(2)        Triage(0)        Working(2)       Needs Input(1)   PR Open(3) 1-1-1 Failed(0)  Done(1) 1
╔══════════════╗                  ╭──────────────╮ ╭──────────────╮ ╭──────────────╮            ╭──────────────╮
║ CAD-21       ║                  │ ⠹ CAD-14     │ │ CAD-18 Slack │ │ ● CAD-7      │            │ CAD-4 Pause… │
║ Import tasks ║                  │ Aggregate    │ │  reminders   │ │ Streak       │            │ ✓ merged #1… │
║ --:-- · 0 t… ║                  │ 1h12m · 54k… │ │ 1h06m · 25k… │ │ 1h28m · 68k… │            ╰──────────────╯
║ ⛓ CAD-20 · … ║                  │ ▰▰▰▰▰▰▱▱ 3/4 │ │ ? How often… │ │ GitHub repo… │
╚══════════════╝                  ╰──────────────╯ ╰──────────────╯ │ #205 draft … │
```

Deliberately, that board covers every state worth seeing: a **tracking parent** with two sub-issues,
a **blocked** task waiting on its schema issue, an agent **mid-work** with subtask progress, one
**waiting on a decision**, a PR that's **approved**, one with **failing CI**, one **conflicting**
with a rebase running (the blinking dot), and one **merged**.

`:reviews` has two PRs awaiting you — one untouched, one already pre-reviewed with findings, so you
can see the review document, the discussion pane and what posting *would* send.

`:issues` has a real backlog in the sqlite tracker. Dispatch one and watch it move: triage runs,
the work pass "reads" and "tests", a draft PR appears, and the card lands in PR Open. It takes a few
seconds and costs nothing.

## What it refuses to do

Demo mode fails loudly rather than half-working, because a demo that quietly calls `gh api` against
a made-up PR is a demo that can surprise someone:

- agent sessions are **scripted** — the SDK is never called
- **no worktree is created**; git is never run
- **PR and review polling are off** — they'd ask `gh` about branches that don't exist
- starting a pre-review, posting one, approving or requesting changes all **decline**, and say so

## Using it for your own work

The two halves are independent, and both are useful on their own:

| | what it's for |
|---|---|
| `"provider": "sqlite"` alone | a real local tracker — issues, sub-issues, blockers — with **real** agents |
| `"demo": true` alone | scripted agents against any tracker, if you want the UI without the spend |

The seed only fires when the board is empty, so anything you dispatch in the demo context sticks
around until you delete `~/.local/state/colinear/contexts/demo/`.
