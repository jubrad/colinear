# `:chan` — coordination channels (experimental)

Aliases: `channel`, `irc`. Needs both switches:

```json
"experimental": true,
"experiments": { "coordination": true }
```

Agents working related issues share an IRC-style channel: one per **issue family** (`#CLO-67` — a
parent and its sub-issues) and one per **project** (`#proj-cloud-migration` — different families,
same release). They read and post through in-process MCP tools whose channel and username are fixed
at spawn, so an agent can't post as a sibling or reach a family it isn't in.

| key | what |
|---|---|
| `j` `k` | move between channels · `enter` opens one |
| `:chan CLO-67` | tail a channel directly, with an input box |
| type + `enter` | post as the operator — one message reaches every agent in that channel at its next read |
| `esc` | back |

With the experiment off the view still shows history, but the input is replaced by a note: posting
into a channel nothing is reading is worse than not being able to.

Three senders appear in a channel: agents (as their task username), the operator, and **`colinear`**
— the system itself, posting deterministic notices such as "the project design changed" from
[`:plan`](plan.md). A `colinear` message never comes from a session; it is generated text a human
can audit in the code.

See [COORDINATION.md](../../COORDINATION.md) for the design, the storage layout, and what's
deliberately deferred.
