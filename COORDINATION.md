# Coordination channels — HIGHLY EXPERIMENTAL

Status: experimental, lives on the `coordination-channels` branch, off by default
(`"coordination": true` in config to enable). Expect rough edges; the design below
also records what is deliberately deferred.

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
- Created lazily on first post/read when coordination is enabled and the task
  has a parent (or is a tracking parent).

### Tools (agents)

Each session gets its own MCP server instance, constructed at spawn with the
channel id and username baked in:

- `channel_read()` — messages since THIS reader's cursor. The cursor is
  server-side, keyed `<channel>:<username>`, persisted across restarts, and
  advanced on read: agents can't double-pull history into context, and a
  resumed session doesn't re-read what its predecessor saw. A brand-new
  reader gets a capped backfill (last 10) rather than full history.
- `channel_post(message)` — appends. Sender and channel are stamped by the
  tool implementation; there is no `from` or `channel` parameter. Identity and
  channel membership are enforced by construction, not by prompt rules — an
  agent cannot spoof another agent or address a foreign channel.

### Prompt discipline

The work/resume/fixci/triage prompts (when a channel exists) instruct:

- READ at session start, before structural/architectural decisions, and
  before opening a PR.
- POST (≤2 lines each): scope claim at start (files/dirs owned), architectural
  decisions siblings must know, advisory shared-resource claims, PR link when
  opened, done notice.
- Operator messages outrank everything else in the channel.

### Operator

`:chan` lists channels; `:chan CLO-67` tails one live with an input box.
Operator posts are stamped `operator`. This is broadcast steering: one message
reaches every family agent at its next read.

### Storage

`~/.local/state/colinear/channels/<name>.jsonl`, one message per line
(`{ts, from, kind: "agent"|"operator", text}`), plus `cursors.json` beside
them. The store sits behind a `ChannelStore` interface — the seam for remote.

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

- Push delivery (interrupting a running agent with a message) — needs
  streaming-input sessions; pull + prompt discipline first.
- Enforced resource leases (`claim_resource` blocking tool) — advisory claims
  in chat first; leases would ride the same MCP server with auto-release on
  session end.
- Per-dispatch coordination toggle in the modals — config flag only for now.
- Per-repo channels (cross-family resource coordination).
- Channel garbage collection.

## Risks

- Token overhead: every read/post costs; mitigated by cursors, capped
  backfill, and the ≤2-line rule. Watch modelUsage on coordinated families.
- Stale claims from dead agents: advisory only; the operator sees the channel
  and can post corrections. Leases fix this properly later.
- Prompt-discipline decay: agents may under-read. If that shows up, inject the
  unread tail into the context block at session start (cheap, deterministic).
