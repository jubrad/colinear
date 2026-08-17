# `:plan` — planning chat

Alias: `chat`. Argument: the project name (`:plan Cloud Migration`).

A long-lived conversation with an agent that can read the repo but not write to it: `Write` and
`Edit` are denied outright. Use it to work out how a project should be split before any of it exists
as issues.

When it proposes work it returns a fenced JSON block, which colinear parses into a **draft list**.

| key | what |
|---|---|
| type | talk to it — `enter` sends |
| `space` | toggle a draft off/on |
| `A` | create the selected drafts as issues in the project |
| `D` | create **and** dispatch them |
| `esc` | leave the input · `q` back |

Nothing reaches the tracker until `A` or `D`. The chat and its drafts survive a restart — the session
is resumed by id, so context isn't lost.

Note: the planner still runs in the TUI process rather than the daemon, so `R` (reload) and quitting
end it. The board's agents are unaffected.
