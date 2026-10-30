# The runner and workspaces

Today the daemon runs every agent session inside its own process and runs `git` directly in
worktrees on its own disk. In cluster mode neither can hold, because the daemon has no checkout and
no agent CLI. This document splits those out into a **runner**: a small process that lives next to a
worktree, runs agent sessions there, and does file and command work there, on the daemon's behalf.

The runner is the first thing built ([WORK-ORDER.md](WORK-ORDER.md)), and it's useful without a
cluster. A runner in a container gives single-user mode real sandboxing.

## Where things run today

| what | where | how |
|---|---|---|
| agent sessions | daemon process | `AgentBackend.runSession` → the Claude Agent SDK or the Codex SDK, in-process |
| colinear's MCP tools (channels, coordinator) | daemon process | `ToolSpec`s (`agents/tools.ts`) whose handlers touch the store and the channel files |
| the `:agents` registry | daemon process | the adapters call `startSession` / `endSession` (`sessions.ts`) |
| worktree creation | daemon | `WorkspaceProvider.ensureTask` (`workspace.ts`): `git worktree add` off the repo's main checkout |
| checks | daemon | `Workspace.exec` in the worktree (`checks.ts`) |
| reading agent-written files | daemon | `.colinear-subtasks.md`, `.colinear-review.md`, the plan draft |
| diffs and review anchors | daemon | `git` in the worktree (`reviewer.ts`, `selfreview.ts`); the result goes to the UI as `reviewDiff` / `taskDiff` frames |
| repo-level work | daemon | `git fetch` in the main checkout; `gh pr list`, `gh api` with the main checkout as cwd (`prs.ts`, `reviews.ts`) |
| plan sessions | daemon | in the plan's own worktree (`plan-<slug>` on `plan/<slug>`, `projectplan.ts`), which the plan chat's `c` and `S` attach to |
| sessions with no worktree | daemon | the todo agent and coordinators run in scratch directories; `n`'s and the project drafts run in the first repo's checkout |
| attach (`s`, `S`) | the TUI's terminal | spawns `claude --resume` or a shell in the worktree, or the same over `ssh` |
| push and open PR | **the agent** | `git push`, `gh pr create` from its own shell |
| backup | daemon | transcripts read from the runtime's directories, `git bundle` in the main checkout |

## The seam

`AgentBackend` (`core/agents/shared.ts`) is already the boundary: nothing above it knows which
runtime runs a session. A new backend, `runner`, implements it by forwarding:

```ts
// the dispatcher's code does not change
const result = await runtimeFor(cfg, 'work').backend.runSession({ prompt, cwd, callbacks, inbox, ... });
```

When the config says sessions run in runners, `runtimeFor` wraps the chosen runtime: it returns a
`RunnerBackend` that carries the inner runtime's name (`claude`, `codex`) and its capabilities, and
whose `runSession` sends the session to the workspace's runner. The runner then calls the real
`claudeBackend` or `codexBackend` on its side. One adapter per runtime, used in both places.

### What can't cross as data

`RunSessionOpts` is mostly data. These parts aren't, and each has a counterpart in the protocol:

| member | daemon side | runner side |
|---|---|---|
| `callbacks` (`onActivity`, `onSessionId`, `onUsage`) | called when the event arrives | sent as events |
| `callbacks.onQuestion` → `PendingQuestion.answer()` | the daemon's `answer` resolves it as today | sends `question` with an id, waits for `answer` |
| `inbox` (`SessionInbox`) | `push()` sends `message`; `drain()` takes the runner's undelivered list from `result` | a local `SessionInbox` fed by `message` |
| `abortController` | `abort()` sends `abort` | aborts the local controller |
| `agent.onRegistered` | called when the registry entry exists, which is daemon-side ([below](#the-registry-moves-above-the-adapters)) | not sent |
| tool **handlers** for `channels` and `coordinator` | run here, against the store and the channel files | an MCP server rebuilt from `toWire` specs, forwarding each call as `tool.call` |

`channels` itself (`SessionChannels`: a username and scopes) is plain data and travels as it is. The
handlers it produces are the part that has to stay. Step 1.1 makes tools data:
`colinearTools` builds `ToolSpec`s with identity closed over, `toWire` sends them without handlers,
and `fromWire` rebuilds tools on the far side whose calls come back. A runner can't widen what a
session may do, because it never holds the handlers.

### The registry moves above the adapters

Both adapters register their session in the `:agents` registry themselves (`startSession`,
`updateSession`, `endSession`). Run in a runner, that would register the session in the runner
process, where nothing reads it. So registration moves out of the adapters into one wrapper in
`agent.ts`, around every `runSession`, fed by the same callbacks the dispatcher gets. The adapters
become pure session runners. That's a refactor with no behaviour change, and it's useful even
without runners: a third runtime can't forget to register.

### The two synchronous questions

`AgentBackend` also has `sessionExists(cwd, id)` and `transcriptDir(cwd)`, both synchronous and
both answered by reading the local disk. Their callers (`projectplan.ts`, `backup.ts`) need them
across a process boundary too.

- **`sessionExists` becomes async** (step 1.3). Locally it reads the disk as now. Through a runner,
  the daemon answers it from its own copy of the transcripts, below. (`fs.exists` can't: the
  transcript is in the agent's config directory, outside the worktree.)
- **`transcriptDir` is answered from the daemon's copy too.** The runner streams every transcript to
  the daemon as it's written (`session.transcript`), and the daemon keeps a copy in its state
  directory. Backup archives those copies. Viewers of a shared item read them too, without waking a
  pod ([sharing.md](sharing.md#transcripts-without-waking-pods)).

## Workspaces

The daemon's direct `git` and file access goes behind a second interface. Step 1.2 builds it
(`core/workspace.ts`):

```ts
interface Workspace {
  /** the worktree as its own side sees it: what prompts and agent cwd use */
  readonly path: string;
  /** never throws for a command that ran and failed; the code says how it went */
  exec(argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  readFile(rel: string): Promise<string | undefined>;
  writeFile(rel: string, content: string): Promise<void>;   // atomic
  exists(rel: string): Promise<boolean>;
}

interface WorkspaceProvider {
  ensureTask(spec: TaskWorktreeSpec, note?: (line: string) => void): Promise<{ workspace: Workspace; branch: string }>;
  open(path: string): Workspace;
  // to come: ensureReview, ensurePlan, ensureScratch, release (may sleep), remove (gone for good)
}
```

Every path is relative to the worktree, and anything that climbs out is refused.

**Repository-level setup belongs to the provider, not to `Workspace`.** Creating a worktree, and
writing the scratch-file excludes into the repository's shared `info/exclude`, happen outside the
worktree. The local provider does them with the main checkout. A runner does them in `prepare`,
where the clone is its own repository.

- **`localWorkspaces`** is today's behaviour. Single-user mode uses it and must not get slower.
- **`RunnerWorkspaceProvider`** asks for a workspace, waits for its runner to connect, and turns
  every call into a protocol request. How the runner gets started is its one variable: a child
  process, a container, or a `ColiWorkspace` the operator turns into a pod
  ([operator.md](operator.md)). The work order builds it in that order.

What still reaches a worktree directly, to be moved by the work order:

- `dispatcher.ts`: the subtask file, `existsSync(task.worktree)` before a resume
- `reviewer.ts`, `selfreview.ts`: review worktrees, the review doc, diff anchors
- `projectplan.ts`: the plan draft
- `gc.ts`: removal
- `backup.ts`: transcripts and `git bundle`

### Plans, and sessions without a worktree

A project plan has its own worktree (`plan-<slug>` on branch `plan/<slug>`), which its sessions run
in and the plan chat attaches to. It's a workspace like a task's: `ColiWorkspace` `kind: plan`,
created by the provider's `ensurePlan`.

The todo agent, coordinators, and the `n` and project drafts don't work in any worktree. Some need
no checkout at all; the drafts read the primary repo to use accurate names. They get a **scratch
workspace**: one per user, long-lived, small. It holds a directory per scratch session
and a shallow, read-only clone of each org repo for drafts to read. It sleeps when idle like any
other workspace (`ColiWorkspace` `kind: scratch`, [operator.md](operator.md#coliworkspace)).

## Repo-level work in the daemon

Some of what the daemon does isn't in any worktree. It polls PRs, reads the current GitHub user,
resolves a repo's owner and name from its remote, and posts reviews. Today that runs `gh` and
`git` with the main checkout as cwd.

In cluster mode there's no main checkout, so these address the repo **by name**: the org config
has each repo's URL ([config.md](config.md)), which gives owner and name. `gh` calls take
`--repo owner/name` instead of a cwd, and `git remote -v` is no longer needed. The daemon's image
has `git` and `gh`, and no agent CLI. It runs them with the user's GitHub token from its own vault
([credentials.md](credentials.md)), passed per call, never written to disk.

This is its own step in the work order, and it's harmless in single-user mode: a repo already
knows its remote there too.

## The protocol

NDJSON frames, one JSON object per line. The transport depends on where the runner is:

| runner | transport | authentication |
|---|---|---|
| in-process (today, the default) | none: direct calls | none |
| child process | stdio pipes | none: the daemon spawned it |
| container (single-user sandbox) | a unix socket in a directory mounted into the container | file permissions |
| pod | WebSocket, **the runner dials its daemon** | see below |

Every frame carries `t` (its type). Requests carry `id`, and their reply carries the same `id`.

**Daemon → runner**

| `t` | fields | meaning |
|---|---|---|
| `hello` | `protocol`, `workspace` | the reply to the runner's `hello`, once its token checks out |
| `credentials` | `version`, `files[]`, `expiresAt` | replace the credential files; see [credentials.md](credentials.md#token-sync). Always sent before `prepare` |
| `prepare` | `id`, `repo`, `branch`, `source` | make the worktree; idempotent. `source` is `{ from: 'remote', base }`, `{ from: 'branch' }` (adopt a pushed branch), or `{ from: 'bundle', data }` (a fork's unpushed commits) |
| `session.start` | `sid`, `runtime`, `opts`, `tools[]` | `opts` is `RunSessionOpts` minus what can't cross; `tools` are `WireTool`s |
| `session.message` | `sid`, `text` | push to the session's inbox |
| `session.answer` | `sid`, `qid`, `answers[]` | answer a question |
| `session.abort` | `sid` | cancel |
| `tool.result` | `cid`, `ok`, `text` | the answer to a `tool.call` |
| `exec` | `id`, `argv`, `cwd`, `env`, `timeoutMs`, `input`, `maxOutput` | `Workspace.exec` |
| `exec.cancel` | `id` | stop a running `exec`: what `ExecOpts.signal` becomes across the wire |
| `fs.read` / `fs.write` / `fs.exists` | `id`, `path`, (`content`) | relative to the worktree, refused if it escapes it |
| `pty.open` / `pty.data` / `pty.resize` / `pty.close` | `id`, ... | an interactive terminal for `s` and `S` |

**Runner → daemon**

| `t` | fields | meaning |
|---|---|---|
| `hello` | `protocol`, `version`, `runtimes[]`, `token` | **the first frame**, since the runner dials. `token` is its projected service-account token (in a cluster; absent locally). A daemon on another protocol version, or that rejects the token, closes |
| `session.activity` / `.id` / `.usage` | `sid`, ... | the callbacks |
| `session.question` | `sid`, `qid`, `kind`, `questions[]` | the agent asked something |
| `session.delivered` | `sid` | a turn completed: in-flight inbox messages are now delivered |
| `session.transcript` | `sid`, `seq`, `lines[]` | new transcript lines, in order |
| `session.result` | `sid`, `result`, `undelivered[]` | the `SessionResult`, plus inbox messages that never reached a turn |
| `tool.call` | `sid`, `cid`, `name`, `input` | call a colinear tool |
| `credentials.ack` | `version` | the files are written |
| `reply` | `id`, `ok`, ... | the answer to a request |
| `pty.data` / `pty.exit` | `id`, ... | terminal output |

`exec` output is capped at `maxOutput` per stream (1 MB by default, the tail) and says so when it
truncates. Long commands
stream nothing until they finish; checks don't need more.

### Authentication in a cluster

A fake runner would receive pushed credentials, and a fake daemon could drive an agent. Neither
side may use a stored secret, and **the workspace pod has no access to the Kubernetes API**, since
the agent can read anything the runner can.

- **The runner dials its daemon**, at the `coli-daemon` Service in its own namespace. Nothing else
  can answer to that name, and `NetworkPolicy` lets a workspace pod reach only that port.
- **The runner presents a projected service-account token** with audience `coli-daemon`, in its
  `hello`.
  Kubernetes mints and rotates it and binds it to the pod. The API server rejects it, since it
  carries the wrong audience, so the agent gains nothing by reading it.
- **The daemon checks it with a `TokenReview`.** That confirms the namespace, the service account,
  and the pod name. The daemon accepts only the pod the operator recorded in that `ColiWorkspace`'s
  status.

An agent can connect to its own daemon pretending to be its own runner. That gains it nothing it
doesn't already have: the same pod, the same credentials, the same tools.

### Disconnects

v1: a dropped connection is treated like a daemon restart is today. The session is aborted, and the
task goes to `interrupted`, where `r` resumes it by session id.

Later: the runner keeps the session going and buffers events by sequence number, and a reconnecting
daemon replays from the last one it saw. That makes daemon restarts and upgrades free for running
agents, which they are not today. It's listed separately in the work order because it's a real
improvement but not a blocker.

## Runner images

A workspace pod's image is the agent's whole environment: the agent CLIs, `git`, `gh`, `ripgrep`, and
whatever the repo needs to build and test. That's a property of the **repo**, so the org config
names an image per repo ([config.md](config.md)), defaulting to a base image built from this
repository. The runner is the image's entrypoint; it's one `node` process.

The daemon's image has `git` and `gh` for [repo-level work](#repo-level-work-in-the-daemon), and no
agent CLI or toolchains. In cluster mode the daemon must not be able to run an agent itself, and
leaving the CLIs out of its image makes that a fact rather than a setting.

## Attach

`s` and `S` hand your terminal to a process in the worktree. With a runner, that process runs in the
workspace pod, so the TUI gets a **pty over the protocol**:

1. The TUI sends `attach` to the daemon (through the gateway in cluster mode).
2. The daemon opens a `pty` on the runner with the same argv `attachArgv` builds today.
3. The TUI suspends Ink, puts the local terminal in raw mode, and pipes bytes both ways until the
   pty exits.

That replaces the `ssh -t` handoff in remote mode too, and it means the TUI never needs a path that
exists on another machine. The "same-named directory on the wrong host" failure that
[remote.md](../../docs/remote.md) guards against can't happen.

Transcripts live in the workspace's agent config directory, on its volume, so `--resume` finds them
after the pod has slept and woken.

## Local modes

The runner arrives in single-user mode first, in three steps. Each is shippable alone:

1. **In-process** is today. The refactors (tools as data, `Workspace`, the registry wrapper) land
   with no change in behaviour.
2. **Child process.** `"runner": "process"` runs each workspace's sessions in a child `coli runner`
   over stdio. That proves the protocol with nothing but Node, and it's what the protocol checks
   drive.
3. **Container.** `"runner": { "container": "image" }` starts one container per workspace with only
   that worktree mounted, and pushes credentials into it the same way the cluster does. This is
   sandboxing for single-user mode: an agent that can see one checkout and holds short-lived tokens.

`runner` is a new config key ([config.md](config.md#what-belongs-where)); absent means in-process.

## Testing

- **`tools.check.ts`** (built in 1.1): tool scope and length rules survive the trip without
  handlers, and far calls are forwarded.
- **`workspace.check.ts`** (built in 1.2): the `Workspace` contract and worktree creation against
  temp repos. When the runner provider exists, the same `contract()` runs against it over stdio and
  must give identical results.
- **`runner.check.ts`** drives a fake runtime through `RunnerBackend` → stdio → runner, then
  asserts what comes out: callbacks, questions answered, inbox delivery, undelivered
  messages on abort, tool calls round-tripped to daemon-side handlers, transcripts streamed, a
  credentials push acknowledged before `prepare`, and a dropped connection leaving the task
  `interrupted`. That's the same shape as `agent.check.ts`, one process boundary further.
- `bin/check` runs all of them.

## Open questions

- **Codex tools.** The Codex adapter doesn't expose colinear's MCP tools today. Now that tools are
  `ToolSpec`s it could, through `codex`'s MCP client config. Is that worth doing in this work, or
  after?
- **Long checks.** Do checks need streamed output in the UI, or is the result at the end enough as
  it is today?
