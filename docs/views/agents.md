# `:agents` — what is running right now

Alias: `ps`. No argument.

Every agent the daemon has running, in one list, with **what started it**. Sessions belong to
four different things — a task, a review, a project plan, a one-off draft — and each was only
visible in the view that owned it, if it had one at all.

```
  KIND            WORKING ON            STARTED BY            FOR      TOKENS   DOING
⠙ work            CLO-203               dispatch              4m12s    182k     ⚒ Bash cargo clippy -p mz…
⠹ review          cloud#13251           you pressed r         1m03s    54k      ⚒ Read src/analytics.py
  draft-issue     make the retry back…  you pressed n in :i…  8s       2k       created CLO-214
```

| column | what |
|---|---|
| `KIND` | `work` · `triage` · `maintenance` (a CI fix or rebase on an open PR) · `coordinator` · `review` · `plan` · `draft-issue` · `draft-project` |
| `WORKING ON` | the issue, PR or project it belongs to |
| `STARTED BY` | why it exists — *dispatch*, *CI failing*, *you pressed r*, *you messaged the parent* |
| `FOR` | how long it has been going |
| `DOING` | its last line, or its outcome once finished |

`enter` opens whatever owns it — the task, the review, the plan. A finished agent stays listed for
ten minutes so you can see what just happened; a running one is never aged out, because an agent
that has been going for an hour is a fact worth seeing rather than something to tidy away.

The selected agent's worktree and a ready-to-paste `claude --resume` are shown underneath.

## Drafts

`n` in [`:issues`](issues.md) or [`:projects`](projects.md) starts a drafting agent, and those used
to run inside the TUI: closing the progress popup left it invisible, and reloading the UI (`R`) or
quitting killed it outright. They run in the daemon now, like every other agent. `esc` closes the
popup, not the session — the draft keeps going, it appears here, and the toast still lands when the
issue is filed.

This view is read-only. What you can do to an agent depends on what it is working on — `x` cancels
a task in one place and a review in another — so `enter` takes you where those keys mean something
rather than pretending one verb fits all of them.
