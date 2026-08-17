# `:board` — the kanban

Aliases: `b`, `bo`. Every dispatched task, in the column that says what it's waiting on.

```
Queued(1)        Triage(0)        Working(1)       Needs Input(1)   PR Open(2) 1-1   Failed(0)        Done(1) 1
╔══════════════╗                  ╭──────────────╮ ╭──────────────╮ ╭──────────────╮                  ╭──────────────╮
║ CLO-142 Add  ║                  │ ⠴ CLO-140    │ │ CLO-138      │ │ SAS-91 Emit  │                  │ CLO-131 Dro… │
║ a rollback   ║                  │ Retry        │ │ Decide auth  │ │ metering     │                  │ ✓ merged #1… │
║ 7:00 · 27k … ║                  │ 7:00 · 27k … │ │ 7:00 · 27k … │ │ 7:00 · 27k … │                  ╰──────────────╯
║ pushing the… ║                  │ ▰▰▰▰▱▱▱▱ 1/2 │ │ ? Which mec… │ │ pushing the… │
╚══════════════╝                  │ pushing the… │ ╰──────────────╯ │ #1204 open … │
                                  ╰──────────────╯                  ╰──────────────╯
                                                                    ▼ 1 more — i/k …
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
```

Columns are Queued · Triage · Working · Needs Input · PR Open · Failed · Done. Within a column cards
sort by what wants you first — changes requested, conflicting, approved, draft, awaiting review — and
the header carries a coloured count per state (`PR Open(7) 1-1-2-2-1`): pink changes-requested, red
conflicting, green approved, grey draft, orange awaiting, purple merged, red closed.

A card shows live duration, tokens, repo, subtask progress, its question if it has one, blocked-by
chains, checks, and each PR with CI and review state. A **blinking dot** means a maintenance session
is running on an already-open PR — green rebasing, amber fixing CI — rather than the feature being
rewritten.

## Keys

| key | what |
|---|---|
| `j` `l` / ← → | move between columns |
| `i` `k` / ↑ ↓ | move between cards |
| `/` | search — id, title, repo, status, PR state, CI. `/conflict`, `/needs`, `/failing` |
| `,` | sort within columns |
| `enter` | [task detail](task.md) |
| `a` | answer the agent's question ([the form](task.md#answering-questions)) |
| `1`–`9` | pick an option outright, when there's only one question |
| `m` | edit the task — repo, pinned PR, instructions, model, triage, auto-rebase, auto-dispatch |
| `M` | message the agent without attaching |
| `u` | dispatch this parent's sub-issues (picker) |
| `s` | attach `claude` in the worktree · `S` a plain shell |
| `x` cancel · `r` resume · `f` force-start a blocked task · `b` rebase a conflicting PR |
| `c` | post the triage escalation to the tracker |
| `o` open the PR · `O` open the issue · `n` back to issues |

The board and [`:tasks`](tasks.md) do the same things with the same keys; only movement differs.
