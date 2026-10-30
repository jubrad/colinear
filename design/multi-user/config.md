# Central config

In a cluster, some settings are the org's: which repos exist, which images build them, which models
are allowed, what agents are never allowed to do. Others are each person's: their default model,
their custom views, their editor. Config becomes two layers, with locks on the keys the org must
decide.

## Layers

```text
built-in defaults   →   org layer (ColiOrg)   →   user layer (the daemon's config file)
```

Later layers override earlier ones, key by key, except where the org layer locks a key or a merge
rule below says otherwise. The result is the same `Config` the daemon uses today, so nothing
downstream of `loadConfig` changes.

Single-user mode has no org layer, and behaves exactly as it does now.

## The org layer

`ColiOrg` holds it ([operator.md](operator.md#coliorg)). The operator
renders it into a `ConfigMap` in each user's namespace, mounted into the daemon at
`/etc/colinear/org.json`. Kubernetes updates the mounted file when the `ConfigMap` changes, and the
daemon watches it and reloads, the same as `R` triggering `reloadConfig` today.

```yaml
apiVersion: colinear.dev/v1alpha1
kind: ColiOrg
metadata: { name: org }
spec:
  users: { allow: ["*@example.com"], admins: ["alice@example.com"] }
  tracker: { provider: linear, oauthClientId: "..." }
  github: { appClientId: "...", appSlug: "colinear-example" }
  repos:
    - name: api
      url: https://github.com/example/api
      defaultBranch: main
      description: The public API service
      image: ghcr.io/example/coli-workspace-api:2026-10
      class: large
      checks: [{ name: lint, run: bin/lint }]
  workspaceClasses:
    small: { cpu: "2", memory: 8Gi, disk: 50Gi }
    large: { cpu: "8", memory: 32Gi, disk: 200Gi }
  idle: 30m
  models: { allow: [sonnet, opus, fable, haiku, gpt-5.6-sol] }
  config:                    # anything a user's config can hold, as the org's default
    model: { general: sonnet, review: opus }
    agentPermissionMode: auto
    denyTools: ["Bash(git push --force:*)"]
    guidance: { general: "..." }
    autoSplit: true
  locked: [agentPermissionMode, denyTools]
  limits: { concurrency: 4, awakeWorkspaces: 5, cpu: "16", memory: 64Gi, storage: 500Gi }
```

## What belongs where

| key | layer | rule |
|---|---|---|
| `repos` | **org only** | In a cluster the operator can only build workspaces for repos it knows. A user's `repos` is ignored, and `:config` says so. |
| tracker provider, OAuth and App client ids | **org only** | One tracker per install. |
| `model`, `fallbackModel` | either | The user's choice wins, within `models.allow` if the org sets one. |
| `agentPermissionMode` | either, lockable | Locked, it's the org's. Unlocked, the user may only choose a **stricter** mode than the org's. |
| `denyTools` | both | **Union.** A user can add rules and can't remove the org's. |
| `guidance` | both | **Concatenated**, org first, per scope. |
| `concurrency` | user, capped | `min(user, limits.concurrency)` |
| `runner` | **org only** in a cluster | Always pods there. In single-user mode it's the user's: absent (in-process), `"process"`, or `{ "container": image }` ([runner.md](runner.md#local-modes)) |
| `autoSplit`, `ciAutofix`, `autoRebase`, `autoDispatchSubs`, `stateSync` | either, lockable | Org default, user override unless locked. |
| `retentionDays`, `worktreeRetentionDays` | either, lockable | |
| custom views, dispatch presets, `editor`, `terminal`, notifications, UI state | **user only** | Personal. |

Four keys disappear from a user's config in cluster mode, because the daemon doesn't own them any
more:

- `linearApiKey`: replaced by the Linear connection ([credentials.md](credentials.md#linear))
- `remote`: the daemon is already remote
- repo `path` and `worktreeRoot`: workspaces aren't paths on the daemon's disk

## Seeing it

`:config` shows each value with where it came from (`default`, `org`, `you`) and a lock beside
locked keys, and lists the user keys being ignored with the reason. Editing a locked key is refused in the editor with the reason, not silently dropped
on save.

## Daemons outside the cluster

The goals ask that daemons can pick up a central config. A daemon on a laptop or a VM could follow
the org layer too: the gateway serves it read-only at `/v1/org-config` to signed-in users, and a
single-user daemon with `"org": "https://coli.example-tailnet.ts.net"` fetches it on start and on
`R`. Repos would still need local paths there, so the org's repo list would merge by name with the
user's paths rather than replace them. That's a later step in the work order.

## Implementation notes

- `loadConfig` gains an `orgLayer` argument and a `lockedKeys` set. The merge is a pure function,
  `mergeLayers(defaults, org, user, locked) → { config, sources }`, so it can be checked on its own.
- `config.check.ts` covers each row of the table above, including that a locked key edited by the
  user keeps the org's value and records the refusal.
- The org layer arrives through a file in both cluster and future laptop mode, so the daemon has one
  code path for it.

## Open questions

- **Per-team org layers.** One org layer per install is the starting point. Do teams need their own
  repos and defaults inside one install? If so, a `ColiTeam` layer sits between org and user.
- **Images per branch.** A repo's toolchain changes over time. Is one image per repo enough, or does
  the image need to follow the branch (built in CI, named by commit)?
