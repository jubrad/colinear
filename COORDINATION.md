# Coordination channels — EXPERIMENTAL

Status: merged, off by default, behind two switches:

```json
"experimental": true,
"experiments": { "coordination": true }
```

Both have to be true. The master switch exists so one line turns every experiment
off when something misbehaves, without you having to remember which features you
had enabled. A feature named without the master switch — or a name that isn't an
experiment at all — is written to the debug log rather than silently ignored.

Expect rough edges. The design below also records what is deliberately deferred.

## Problem

Sub-issue agents run in parallel with static context only (the family block:
parent goal + sibling titles/states). They can't tell each other what they're
actually doing — which files they claimed, architectural decisions they made,
PRs they opened, shared test resources they're hogging. Result: overlapping
solutions, boundary drift, contention.

## Design

An IRC-ish message channel per issue family, exposed to agents as in-process
MCP tools and to the operator as a TUI view.

### Channels

- One channel per family, named after the parent: `#CLO-67`.
- Members: agents working the parent or any of its sub-issues, plus the operator.
- Created lazily on first post/read. A task with no parent and no sub-issues
  never gets one — it has nobody to coordinate with.

### Tools (agents)

Each session gets its own MCP server instance, constructed at spawn with the
channel id and username baked in:

- `channel_read()` — messages since THIS reader's cursor. The cursor is
  server-side, keyed `<channel>:<username>`, persisted across restarts, and
  advanced on read: agents can't double-pull history into context, and a
  resumed session doesn't re-read what its predecessor saw. A brand-new
  reader gets a capped backfill (last 10) rather than full history. Own
  messages are filtered out — an agent already knows what it said.
- `channel_post(message)` — appends. Sender and channel are stamped by the
  tool implementation; there is no `from` or `channel` parameter. Identity and
  channel membership are enforced by construction, not by prompt rules — an
  agent cannot spoof another agent or address a foreign channel.

Both are auto-approved in `canUseTool` (they're `mcp__colinear__*`): a
permission prompt per message would make coordination unusable. Recent SDKs
defer MCP tool schemas, so an agent may call `ToolSearch` before its first
channel call — the prompt block names both tools explicitly, which is what
makes that resolve.

### Prompt discipline

The work and (for sub-issues) triage prompts gain a channel block instructing:

- READ at session start, before structural/architectural decisions, and
  before opening a PR.
- POST (≤2 lines each): scope claim at start (files/dirs owned), architectural
  decisions siblings must know, advisory shared-resource claims, PR link when
  opened, done notice.
- Operator messages outrank everything else in the channel.

### Projects

A family channel reaches the agents whose work overlaps yours. A **project
channel** reaches the ones you would otherwise never hear from: different
families, same release. Any issue with a Linear project gets one, named after
the project — `#proj-cloud-migration` — and an agent working that issue is in
both.

Two memberships, one pair of tools. `channel_read` and `channel_post` take a
`scope` (`"family"` or `"project"`), and the enum contains exactly the channels
*this* session belongs to: the parameter picks among memberships rather than
naming a channel, so an agent still cannot read or post to a family it isn't
in. Default is the family channel — the narrower one.

The prompt asks for different discipline per channel, because the failure mode
differs. Family: scope claims, architectural decisions, PR links, done notices.
Project: only what someone outside your family would need — a shared interface
or schema you are changing, a contended environment you are taking, a decision
that constrains other issues. A project channel that fills with family business
is one nobody reads.

`M` in `:project NAME` opens that project's channel; one operator message
reaches every agent working an issue in it, across families.

### Coordinator sessions

A parent whose work happens in sub-issues has no session of its own, so there
was nobody to tell "cancel that one" or "we need another sub-issue for the
rollback". With the experiment on, messaging a tracking parent (`M`) — or `r`
on its card — starts a **coordinator**: an agent that manages the family
instead of writing code.

It gets no checkout (a scratch directory, or the worktree it already had) and
these tools beside the channel:

- `family_status` — every sub-issue's live colinear state: status, PR and CI,
  blockers, last activity. Fresher than the prompt it started with.
- `family_message` — relay an instruction to a sibling's agent. This is the
  same path as `M`, so a running agent reads it at its next turn and an idle
  one is woken.
- `family_cancel` — stop a sibling's session, with a reason. Recoverable: the
  operator can resume it.
- `family_propose` — offer new sub-issues.

Every one of those is something the operator can already do by hand, so the
agent gains reach, not authority. The tools are built per session with the
family closed over, so a coordinator can only touch its own sub-issues —
naming a stranger returns "not a sub-issue of this family".

**It cannot create Linear issues.** `family_propose` puts them on the parent
card and the operator presses `A` (or `D` to create and dispatch), through the
same review UI a `too_big` triage split uses. Nothing reaches Linear without
being asked, and an agent that can spawn issues unattended is exactly what that
rule is for. The parent stays `tracking` throughout — coordinating is not the
parent going back into development.

The project's **plan session** (`:plan`) gets the same tools, scoped to the
project's dispatched issues instead of a parent's children, and joins the
project channel as `plan`. One difference: its `family_propose` only points
back at the draft's ```plan fence — the fence is the plan's single proposal
surface, and the operator's `A` is its gate; a second path around that gate is
exactly what must not exist.

### Operator

`:chan` lists channels; `:chan CLO-67` tails one live with an input box.
Operator posts are stamped `operator`. This is broadcast steering: one message
reaches every family agent at its next read. With the experiment off the view
still shows history, but the input is replaced by a note — posting into a
channel nothing is reading is worse than not being able to.

### Storage and the process split

`<state dir>/channels/<name>.jsonl`, one message per line
(`{ts, from, kind: "agent"|"operator", text}`), plus `cursors.json` beside
them. The state dir is context-aware, so contexts get separate channels.

Agents live in the daemon, so messages arrive in the TUI as file writes rather
than store deltas: the view re-reads once a second. Operator posts go the other
way — over the socket as a `channelPost` command — so each message log has a
single writing process rather than two racing appenders. The store sits behind
a `ChannelStore` interface, which is also the seam for remote.

## Remote execution (deferred, but designed for)

Goal someday: dispatch agents to a VM/sandbox. Impact analysis:

- Four subsystems assume localhost today: worktree provisioning, the session
  runner (in-process SDK), checks, attach. A remote executor is a thin runner
  on the target that provisions the workspace, runs the SDK session, and
  streams events back (ssh + ndjson suffices). `gh`/Linear polling stay local.
  Attach becomes `ssh -t host claude --resume <id>`.
- Channels: remote agents can't reach an in-process tool server, but MCP
  serves over HTTP/SSE. Because tools are defined transport-agnostically and
  the store is behind an interface, the remote story is: colinear hosts the
  same tools over HTTP, the runner connects through an ssh reverse tunnel.
  No channel rewrite.
- Reserved: `executor` field on repo/dispatch config (unimplemented).

## Deliberately deferred

- Pushing *channel* messages to family agents. The mechanism now exists —
  work sessions are streaming-input, and `M` pushes an operator message into a
  live one (see DESIGN "Task lifecycle") — so this is a wiring job: fan a
  channel post out to the inboxes of every live session in that family instead
  of waiting for each agent to call `channel_read`. That would also retire the
  prompt-discipline-decay risk below. Left undone until coordination has been
  dogfooded enough to know it earns its tokens.
- Enforced resource leases (`claim_resource` blocking tool) — advisory claims
  in chat first; leases would ride the same MCP server with auto-release on
  session end.
- Per-dispatch coordination toggle in the modals — config flag only for now.
- Per-repo channels (cross-family resource coordination).
- Channel garbage collection: `coli gc` doesn't touch `channels/`, and nothing
  else prunes it. The files are tiny, but they are forever.

## Risks

- Token overhead: every read/post costs, and the channel block lengthens every
  prompt in a coordinated family. Mitigated by cursors, capped backfill, and
  the ≤2-line rule. Watch `:costs` on coordinated families and compare against
  an uncoordinated one before believing it pays.
- Stale claims from dead agents: advisory only; the operator sees the channel
  and can post corrections. Leases fix this properly later.
- Prompt-discipline decay: agents may under-read. If that shows up, inject the
  unread tail into the context block at session start (cheap, deterministic).
- The messages are agent-written text that lands in other agents' context. A
  confused agent can mislead its siblings, and nothing validates a claim.
