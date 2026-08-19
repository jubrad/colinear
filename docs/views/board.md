# `:board` — the kanban

Aliases: `b`, `bo`. Every dispatched task, in the column that says what it's waiting on.

![The board with CAD-14 selected in Working: its subtask checklist and the tail of its activity log fill the detail pane](../images/board.png)

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
| `M` | message the agent without attaching — a multi-line box; `ctrl+d` sends, `ctrl+q` queues without waking |
| `u` | dispatch this parent's sub-issues (picker) |
| `s` | attach `claude` in the worktree · `S` a plain shell |
| `x` cancel · `r` resume — or start the agent on a [manually dispatched](../dispatch.md#manual-dispatch-a-worktree-no-agent) task · `f` force-start a blocked task · `b` rebase a conflicting PR |
| `c` | post the triage escalation to the tracker |
| `o` open the PR · `O` open the issue · `n` back to issues |

The board and [`:tasks`](tasks.md) do the same things with the same keys; only movement differs.
