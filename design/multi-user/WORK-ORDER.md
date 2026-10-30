# Work order

The order the multi-user work gets built in. Each numbered step is one pull request into the
`multi-user` branch, small enough to review, and leaves `bin/check` passing.

**Single-user mode works after every step.** The early milestones are refactors and features that
make single-user colinear better on their own, so if the cluster work stops halfway, what landed is
still worth having.

Status: ☐ not started · ◐ in progress or in review · ☑ merged

## The shape

```mermaid
flowchart LR
  M0[M0 spikes]
  M1[M1 seams] --> M2[M2 runner]
  M2 --> M3[M3 cluster]
  M3 --> M4[M4 gateway]
  M1 --> M4
  M2 --> M5[M5 credentials]
  M3 --> M5
  M4 --> M5
  M4 --> M6[M6 sharing]
  M5 --> M6
  M1 --> M7[M7 web UI]
  M4 --> M7
  M6 --> M8[M8 later]
  M0 -. 0.1, 0.2 .-> M2
  M0 -. 0.1, 0.2 .-> M5
  M0 -. 0.3 .-> M4
  M0 -. 0.4 .-> M4
```

M0 and M1 start in parallel. M0 is mostly questions only a person can answer. M1 is code that
everything else stands on. Dotted lines are the spikes a later step waits for; the step says which.
M7's later steps also wait on M5 and M6 (listed per step).

## M0: spikes

Answers that change the design. Nothing here merges as product code.

| | step | why first | needs |
|---|---|---|---|
| ☐ | **0.1 Claude credential behaviour.** In a scratch `CLAUDE_CONFIG_DIR` with its own login, find out: does the CLI run with an access token and no refresh token? Does it re-read a replaced credentials file mid-session? Is there a command that forces a renewal without a session? Script: [spikes/claude-credentials.md](spikes/claude-credentials.md) | Decides how token sync works for agents ([credentials.md](credentials.md#claude-and-codex)) | **you**: a fresh `claude` login |
| ☐ | **0.2 Codex, the same three questions** | Same, for Codex | **you**: a fresh `codex` login |
| ☐ | **0.3 Tailscale identity headers.** Confirm `tailscale serve` in a sidecar passes `Tailscale-User-Login` to a loopback backend, and doesn't for tagged devices | The gateway's whole identity story ([gateway.md](gateway.md#identity)) | a tailnet |
| ☐ | **0.4 Subscription terms.** Confirm the Claude and Codex terms allow each user's own login in a cluster daemon | Before anyone signs in to a shared install | **you** |

## M1: seams

Refactors with no behaviour change, then the thin client. These would be good for `main` on their own.

| | step | notes |
|---|---|---|
| ◐ | **1.1 Tools as data.** colinear's MCP tools become `ToolSpec`s in `agents/tools.ts`; `toWire`/`fromWire` carry them across a process boundary without handlers | [#143](https://github.com/jubrad/colinear/pull/143). [runner.md](runner.md#what-cant-cross-as-data) |
| ◐ | **1.2 `Workspace` and `localWorkspaces`**: the interface, worktree creation moved out of the dispatcher, checks through `Workspace.exec` | [#144](https://github.com/jubrad/colinear/pull/144). [runner.md](runner.md#workspaces) |
| ◐ | **1.3 The registry above the adapters, and an async `sessionExists`.** One wrapper in `agent.ts` registers every session; the adapters stop calling `sessions.ts` | [#145](https://github.com/jubrad/colinear/pull/145). [runner.md](runner.md#the-registry-moves-above-the-adapters) |
| ◐ | **1.4 The rest of the dispatcher onto `Workspace`**: the subtask file, the worktree-exists check before a resume | [#147](https://github.com/jubrad/colinear/pull/147) |
| ◐ | **1.5 Reviews, plans and gc onto `Workspace`**: `reviewer.ts`, `selfreview.ts`, plan worktrees, gc removal; the provider gains `ensureReview`, `ensurePlan`, `remove` and `Workspace.watch` | Reviews [#148](https://github.com/jubrad/colinear/pull/148), plans and gc [#149](https://github.com/jubrad/colinear/pull/149). Fixed on the way: the review doc's git exclude was written where git ignores it |
| ☐ | **1.5b The plan draft into the plan's workspace**, and `ensureScratch` for sessions with no worktree | The draft lives in the daemon's state dir today and the agent is told that absolute path, which a runner can't reach ([runner.md](runner.md#plans-and-sessions-without-a-worktree)) |
| ◐ | **1.6 Repo-level work by name**: PR polling takes `--repo owner/name` (`repoSlug`) instead of a main-checkout cwd; a new optional `github` repo key | [#150](https://github.com/jubrad/colinear/pull/150). Review checkouts still use `git remote -v` through the local provider, which is where it belongs |
| ◐ | **1.7 A redacted `hello`, and the `provider` commands.** Views keep calling `providerFor(cfg)`; on the client it's a proxy whose calls the daemon makes, from an allowlist. The TUI never receives a key | [#151](https://github.com/jubrad/colinear/pull/151). Protocol 21. `thinclient.check.ts` runs a real demo daemon. `coli issue add` (a CLI command, not the TUI) still calls the tracker itself |
| ◐ | **1.8 The rest of the thin client**: `gh pr ready` as a daemon command; review-doc and plan-draft editing as whole-document transfers to a local temp copy | [#152](https://github.com/jubrad/colinear/pull/152). Protocol 22 |

## M2: the runner, in single-user mode

| | step | notes |
|---|---|---|
| ◐ | **2.1 Protocol types, `coli runner` over stdio, and `RunnerBackend`.** `"runner": "process"` runs each session in a child. A runner that dies mid-session fails it (`error`, resumable with `r`) | [#153](https://github.com/jubrad/colinear/pull/153). `runner.check.ts` |
| ☐ | **2.2 Workspace operations and `prepare` through the runner** | `workspace.check.ts` runs its `contract()` against the runner too, with identical results |
| ☐ | **2.3 Transcripts streamed to the daemon**; `transcriptDir`, `sessionExists` and backup answered from the daemon's copies | [runner.md](runner.md#the-two-synchronous-questions) |
| ☐ | **2.4 The `credentials` frame and token sync**, with a test credential source; real logins arrive in M5 | Waits on 0.1 and 0.2 for the file layout |
| ☐ | **2.5 Attach over a pty stream** | Replaces the `ssh -t` handoff in remote mode too |
| ☐ | **2.6 Container runner**: `"runner": { "container": "image" }`, one container per workspace with only its worktree mounted | Single-user sandboxing. Docs: a new section in `docs/security.md`, a row in `docs/configuration.md` |

## M3: the cluster

| | step | notes |
|---|---|---|
| ☐ | **3.1 The Rust workspace**: `deploy/` with the four CRD types, `bin/gen-crds --check`, a chart skeleton, CI for `cargo test`, a Dependabot entry for Cargo | [operator.md](operator.md#layout) |
| ☐ | **3.2 `ColiUser` reconcile**: namespace, service accounts, the RBAC rows for daemon, workspace, gateway and operator, the daemon StatefulSet, NetworkPolicy, quota, the OAuth Secret copy | Pure "desired objects" functions, unit tested for the security properties |
| ☐ | **3.3 The org config layer**: `ColiOrg` → `ConfigMap` → the daemon's `mergeLayers`; `:config` shows sources, locks and ignored keys | [config.md](config.md). `config.check.ts` |
| ☐ | **3.0 `:gc` from the provider**: candidates listed by the provider rather than by reading worktree roots off disk, so a cluster can answer with its `ColiWorkspace`s | |
| ☐ | **3.4 `ColiWorkspace` reconcile**: volume, pod template, sleep and wake, finalizer; `task`, `review`, `plan` and `scratch` kinds | |
| ☐ | **3.5 `RunnerWorkspaceProvider` in cluster mode**: create or wake a `ColiWorkspace`, accept its runner's connection, check its token with a `TokenReview` | [runner.md](runner.md#authentication-in-a-cluster) |
| ☐ | **3.6 Images, `bin/kind-up`, and the first `bin/e2e`**: one user, a fake runtime, a workspace that wakes, runs and sleeps | |

## M4: gateway and identity

| | step | notes |
|---|---|---|
| ☐ | **4.1 The gateway**: development identity, `ColiUser` on first sign-in, the `/v1/connect` relay, the `viewer` frame, the `Origin` check. The daemon's WebSocket listener, which trusts only the gateway's token | [gateway.md](gateway.md) |
| ☐ | **4.2 Tailscale in the chart** | Waits on 0.3, and on 0.4 before a real install |
| ☐ | **4.3 `remote.gateway` contexts in the TUI**, and reconnecting with a fresh snapshot when a relay drops | `bin/e2e` connects a real TUI through the gateway |

## M5: credentials

| | step | notes |
|---|---|---|
| ☐ | **5.1 Connection adapters, the vault, and `:connections`**, starting with GitHub (device flow) and Linear (OAuth: a loopback redirect in single-user mode, the gateway's callback in a cluster) | New view: `docs/views/connections.md`. Usable in single-user mode as an alternative to `gh auth` and API keys |
| ☐ | **5.2 Claude and Codex connections** | Waits on 0.1 and 0.2 |
| ☐ | **5.3 Real logins through token sync to cluster runners**, and parking tasks before a broken login's token expires | [credentials.md](credentials.md#when-renewal-fails) |
| ☐ | **5.4 KMS envelope encryption** for the vault, the one vault role and key policy, the operator's Pod Identity association per namespace, and the operator's own AWS rights in the chart | [credentials.md](credentials.md#storage), [operator.md](operator.md#rbac-and-admission) |

## M6: sharing

| | step | notes |
|---|---|---|
| ☐ | **6.1 Read-only sharing**: the share model, owner-side enforcement, viewer snapshots that accept only `fork`, the viewer's repo-access check, `ColiShare` written by the daemon, `:shared`, and `:agents` keeping finished sessions as long as their item | [sharing.md](sharing.md). New view: `docs/views/shared.md` |
| ☐ | **6.2 Forks**: `/v1/fork`, `prepare` from a branch or a bundle, a `fork` capability on runtimes | |
| ☐ | **6.3 Org costs** (`/v1/costs`) | |

## M7: web UI

| | step | notes |
|---|---|---|
| ☐ | **7.1 A browser-safe client core** shared by the TUI and `web/` | [webui.md](webui.md). Needs 1.7 |
| ☐ | **7.2 Board and task** | Needs 4.1 |
| ☐ | **7.3 Shared with me** | Needs 6.1 |
| ☐ | **7.4 Reviews** | |
| ☐ | **7.5 Connections, costs, agents** | Needs 5.1 and 6.3 |
| ☐ | **7.6 Terminal (attach)** | Needs 2.5 |

## M8: later

Worth doing, not needed for the first real use:

- **GitHub out of agents' reach**: push, PR and CI tools served by the daemon
  ([credentials.md](credentials.md#github-in-pods))
- **Runners survive a daemon restart**: buffered events, replayed by sequence number
- **A repo mirror** in the cluster ([operator.md](operator.md#repositories))
- **FQDN egress allowlists** (Cilium)
- **OIDC sign-in**
- **Daemons outside the cluster following the org config** ([config.md](config.md#daemons-outside-the-cluster))
- **Daemon sleep**
- **Collaboration** that keeps every turn on the right person's logins: suggestions, or taking the
  wheel ([sharing.md](sharing.md#why-sharing-isnt-collaborative))

## Rules for this branch

- Every step is a PR into `multi-user`, never into `main`. `main` is merged into `multi-user`
  regularly, not the other way round.
- Each PR updates the design docs if it changes what they say, and ticks its row here.
- A new view gets its `docs/views/<name>.md` in the same PR (`bin/gen-docs` fails without it), and
  a new config key gets its row in `docs/configuration.md`.
- `bin/check` passes on every PR. From 3.6, `bin/e2e` does too.
- Nothing internal (repo names, issue identifiers, hostnames) goes in these docs or the code. This
  repository is public.
