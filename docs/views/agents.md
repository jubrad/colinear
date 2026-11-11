# `:agents` — what is running right now

Alias: `ps`. No argument.

Every agent, in the order it wants you: **stopped on a question**, **working**, **just finished**.
Sessions belong to four different things — a task, a review, a project plan, a one-off draft — and
each was only visible in the view that owned it, if it had one at all.

```
  WORKING ON        KIND         FOR   DOING                 ┌──────────────────────────────────────────┐
needs you 1                                                   │ CLO-203 make the retry backoff configur… │
? CLO-203           question     2m    which retry policy…    │ question · dispatch · ran 6m · 2m ago    │
working 2                                                     │                                          │
⠙ CLO-211           work         4m    ⚒ Bash cargo clippy…   │ ? which retry policy should reconnect…   │
⠹ colinear#162      review       1m    ⚒ Read src/core/cod…   │   1. exponential — doubles to 30s        │
just finished 2                                               │   2. fixed 1s                            │
✓ make the retry b… draft-issue  now   created CLO-214        │                                          │
✓ CLO-198           work         3m    PR #412 opened         │ last 3 of 3 steps                        │
                                                              │ ⚒ Bash cargo test -p conn                │
                                                              │ a answers · 1-9 picks · M message · s…   │
                                                              └──────────────────────────────────────────┘
```

**Needs you** is an agent that asked a question and is waiting for the answer. Its session has
*ended* — it is over until you reply — so these come from the tasks and reviews holding a question
rather than from the list of running sessions, and they are listed once, longest-waiting first.
**Working** is every running session, longest-running first. **Just finished** keeps a session for
ten minutes after it ends, with its outcome, so you can see what just happened. One row per thing
being worked on: a task's live session supersedes its earlier finished one.

A label in **bold** has something you have not seen: a question asked, a session started or
finished after you last opened that task or review. Opening it — `enter` here, or from anywhere
else — is what counts as looking.

The pane on the right (below, on a narrow terminal) is the selected agent in full: what started it,
for how long, its model and spend, its question with the options, the last of what it has been
doing, its worktree and a ready-to-paste `claude --resume`.

| key | what |
|---|---|
| `j` `k` / ↑ ↓ | move · `g` top · `G` bottom |
| `enter` | open whatever owns it — the task, the review, the plan |
| `a` | answer its question — the [answer form](task.md#answering-questions); for a review, in the review |
| `1`–`9` | pick an option outright, when there is one question |
| `M` | message the agent without attaching |
| `s` | attach to its session · `S` a shell in its worktree |

`a`, `M`, `s` and `S` act on the **task** behind a row — they mean the same thing on every task, so
they work here as on the board. Cancelling does not: `x` cancels a task in one place and a review in
another, so `enter` takes you where it means one thing.

## Beside every view

**`\`** puts the same list in a rail down the left of every view — two rows an agent, what it is on
and for how long, then what it is doing, bold where there is something new. It answers "what is going
on" without leaving the view you are in; this page is where you act on it.

```
╭ agents · 3 new · \ hides ─╮
│ needs you                 │
│ ? CLO-203              2m │
│   which retry policy sho… │
│ working 2                 │
│ ⠙ CLO-211 work         4m │
│   ⚒ Bash cargo clippy -p… │
│ just finished 2           │
│ ✓ CLO-198 work         3m │
│   PR #412 opened          │
╰───────────────────────────╯
```

It needs a terminal 150 columns wide, and steps aside when a view goes full screen (the annotated
diff) and here on `:agents`, which is the same list with room to act. The view beside it is told the
terminal is narrower by the rail's width, so every view lays itself out as it would on a smaller
screen. Whether it is on is remembered, like the board's layout.

## Drafts

`n` in [`:issues`](issues.md) or [`:projects`](projects.md) starts a drafting agent, and those used
to run inside the TUI: closing the progress popup left it invisible, and reloading the UI (`R`) or
quitting killed it outright. They run in the daemon now, like every other agent. `esc` closes the
popup, not the session — the draft keeps going, it appears here, and the toast still lands when the
issue is filed.
