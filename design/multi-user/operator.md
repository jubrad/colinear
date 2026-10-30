# The operator, CRDs and the Helm chart

The operator is the only component that creates pods. Daemons ask for workspaces by writing a
small custom resource, and the operator decides everything about the pod that serves it: its image,
node, volume, privileges and network. A daemon can't ask for anything the CRD has no field for.

Written in Rust with [kube-rs](https://kube.rs). The gateway ([gateway.md](gateway.md)) lives in
the same Cargo workspace, because both need the CRD types.

## Resources

Group `colinear.dev`, version `v1alpha1`. The group name is a placeholder until there's a domain to
put it under.

| kind | scope | written by | read by |
|---|---|---|---|
| `ColiOrg` | cluster, one per install | an admin (Helm values) | operator, gateway |
| `ColiUser` | cluster | gateway (first sign-in), or an admin | operator, gateway |
| `ColiWorkspace` | user namespace | that user's daemon | operator |
| `ColiShare` | user namespace | that user's daemon | gateway |

### `ColiOrg`

The org config: users, repos, images, classes, defaults and locked keys. Its full schema and how it
reaches daemons are in [config.md](config.md#the-org-layer). The operator uses:

- `users.allow`: who may sign in (tailnet logins or `*@domain`); the gateway checks it
- `repos[].image` and `repos[].class`: what a workspace for that repo runs, and how big it is
- `workspaceClasses`: named sizes as CPU, memory and disk
- `idle`: rendered into the daemon's org config. The daemon runs the idle timer; the operator only
  acts on `awake`.

### `ColiUser`

One per person. The gateway creates it on first sign-in for anyone `users.allow` admits, and an
admin can create or disable one by hand.

```yaml
apiVersion: colinear.dev/v1alpha1
kind: ColiUser
metadata: { name: alice }               # a slug of the login
spec:
  login: alice@example.com              # the tailnet identity
  displayName: Alice
  enabled: true
status:
  namespace: coli-u-alice
  daemon: { ready: true, service: coli-daemon.coli-u-alice.svc:7419 }
```

The operator reconciles it into:

| object | purpose |
|---|---|
| `Namespace coli-u-<slug>` | the isolation boundary, labelled with the user |
| `ServiceAccount coli-daemon`, `coli-workspace` | identities for the two kinds of pod |
| `Role` + `RoleBinding` for `coli-daemon` | see [RBAC](#rbac-and-admission) |
| `ClusterRoleBinding` to `coli-tokenreview` | `coli-daemon` only: it checks its runners' tokens ([runner.md](runner.md#authentication-in-a-cluster)) |
| `StatefulSet coli-daemon` (1 replica) | the user's daemon, with a volume for its state dir |
| `Service coli-daemon` | what the gateway and the user's runners connect to |
| `NetworkPolicy` | see [network](#network) |
| `ResourceQuota` | caps on awake workspaces, CPU and storage per user |
| `ConfigMap coli-org` | the org config layer, rendered for the daemon ([config.md](config.md)) |
| `Secret coli-linear-oauth` | a copy of the org's Linear OAuth client secret, from `coli-system/coli-linear-oauth` (set by Helm values). It identifies the app and can't act as anyone ([credentials.md](credentials.md#linear)) |
| an EKS Pod Identity association | binds `coli-daemon` to the install's one vault role, so it can use the KMS key for its own namespace only ([credentials.md](credentials.md#storage)). AWS only; the operator's own AWS rights are below |

**The daemon is always running** once its `ColiUser` exists. It's one small Node process, and a
daemon that slept would need the gateway to wake it and to know when stopping it was safe. Daemon
sleep is a later step if the numbers ask for it.

Disabling a user (`enabled: false`) scales the daemon to zero and puts every workspace to sleep.
Deleting the `ColiUser` deletes the namespace and everything in it.

### `ColiWorkspace`

One per worktree (a task's, a review's or a plan's), plus one scratch workspace per user for
sessions without a worktree ([runner.md](runner.md#plans-and-sessions-without-a-worktree)).

```yaml
apiVersion: colinear.dev/v1alpha1
kind: ColiWorkspace
metadata: { name: eng-142, namespace: coli-u-alice }
spec:
  kind: task                  # task | review | plan | scratch
  repo: api                   # a name from ColiOrg.repos; absent for scratch
  class: small                # optional; defaults to the repo's class
  awake: true                 # the daemon wants a pod now
status:
  phase: Ready                # Pending | Ready | Sleeping | Failed
  pod: { name: ws-eng-142, ip: 10.1.2.3 }
  message: ""
```

The spec has no image, command, volume, node selector, security context or environment. The daemon
chooses which repo and which size class, both from lists the org config defines. Everything else
is the operator's.

The operator reconciles a workspace into:

- **A `PersistentVolumeClaim`** sized by its class. It lives as long as the workspace, through every
  sleep. The worktree, the agent's config directory (transcripts), and caches go here.
- **A `Pod`, while `awake`**, built from a fixed template:
  - the repo's image (the base image for `scratch`), with the runner as entrypoint
  - service account `coli-workspace`, with `automountServiceAccountToken: false`: no token for the
    Kubernetes API, so an agent in the pod can't talk to the cluster
  - a projected service-account token with audience `coli-daemon` only, which the runner presents
    to its daemon and the API server rejects
  - an in-memory `emptyDir` at `/run/coli/creds` for pushed credentials
    ([credentials.md](credentials.md#where-credentials-land-in-a-pod))
  - the address of its daemon (`coli-daemon.<namespace>.svc`)
  - non-root, no privilege escalation, every capability dropped, `seccompProfile: RuntimeDefault`

Sleep is the daemon's call. When nothing has needed a workspace for `idle`, the daemon sets
`awake: false`. The operator deletes the pod and keeps the volume. Waking is `awake: true` plus
waiting for `Ready` and for the runner to connect. The UI shows a spinner for that wait, like any
other wait on an agent.

Deleting a `ColiWorkspace` (`coli gc`) deletes its pod and volume. A finalizer makes sure the pod is
gone before the volume goes.

### `ColiShare`

The index of shared items, one per shared item, written by the owner's daemon. The gateway lists
them; the owner's daemon stays the authority on access. See
[sharing.md](sharing.md#the-shared-list). The operator doesn't reconcile it.

## RBAC and admission

| who | may | may not |
|---|---|---|
| **daemon** (`coli-daemon`, in its own namespace) | `get`, `list`, `watch`, `create`, `patch`, `delete` on `ColiWorkspace` and `ColiShare`; `get`, `list`, `watch` on pods (to read workspace status); create `TokenReview` | anything outside its namespace; `pods/exec`, creating pods, secrets, roles, or any other resource |
| **workspace** (`coli-workspace`) | nothing | anything: it has no API token |
| **gateway** | `get`, `list`, `watch`, `create` on `ColiUser`; `get`, `list`, `watch` on `ColiShare` (all namespaces) and `ColiOrg` | workspaces, pods, secrets |
| **operator** | what reconciling needs: namespaces, service accounts, roles and bindings, StatefulSets, Services, pods, PVCs, NetworkPolicies, quotas, ConfigMaps; secrets in `coli-u-*` namespaces, and reading `coli-system/coli-linear-oauth` | |

**The operator's AWS rights** come from its own Pod Identity association, set up by the chart: `eks:CreatePodIdentityAssociation` and `eks:DeletePodIdentityAssociation` on the cluster, and `iam:PassRole` on the one vault role. Nothing else in AWS.

The daemon's whole cluster reach is its own `ColiWorkspace` and `ColiShare` objects. The defences,
in order:

1. **The schema.** The CRD has no field for anything security-relevant. `repo` and `class` are
   names the operator looks up; an unknown one makes the workspace `Failed` with a message rather
   than guessing.
2. **RBAC**, as above.
3. **The operator.** Every pod comes from one template in Rust, so there's no YAML for a user to
   influence.

What isn't defended: a user who is also a cluster admin. That's the honest limit stated in the
[README](README.md#threat-model).

## Network

Per user namespace, `NetworkPolicy` allows:

- **Ingress to the daemon** from the gateway's pod, and from this namespace's workspace pods on the
  runner port. The daemon never dials out to the gateway or to its runners; they dial it.
- **Egress from workspace pods** to this namespace's daemon (runner port), the cluster DNS, and the
  outside world. Not to the Kubernetes API, and not to any other namespace.
- **Egress from the daemon** to the cluster DNS, the Kubernetes API, and the outside world.

Workspace pods in different namespaces can never reach each other or each other's daemons.

Outside egress can be narrowed to GitHub, Anthropic, OpenAI and the tracker with an FQDN-aware CNI
(Cilium). Standard `NetworkPolicy` can't name hosts, so the chart offers that as an option rather
than a default.

## Repositories

v1 clones from GitHub straight into the workspace volume, in the runner's `prepare`, with the
user's own short-lived GitHub token and `--filter=blob:none`, so only history comes down and blobs
arrive on demand. That's simple and uses no shared credential.

Big repositories will make that slow on every new workspace. The fix, once measured, is an in-cluster
**mirror** per repo: a Deployment that keeps a bare clone fresh and serves it read-only inside the
cluster, so a workspace clones from the mirror and fetches the rest from GitHub. The mirror needs
read access of its own: a GitHub App installation token with read-only `contents`, which reads code
but can't act as anyone. It's a later step in the work order.

## Nodes

Two Karpenter `NodePool`s, as examples in the chart rather than requirements:

- **`coli-system`**: the operator, gateway and daemons. Small, on-demand.
- **`coli-work`**: workspace pods only, by taint and toleration. On-demand by default. Spot is an
  option, but an interruption kills a running session. Sessions resume by id afterwards, but it's
  a cost the user should choose.

EBS volumes belong to one zone. A sleeping workspace wakes on a node in its volume's zone, which
Karpenter already arranges from the volume's node affinity.

## The Helm chart

`deploy/chart/` installs:

- the CRDs, generated from the Rust types (`bin/gen-crds`, which takes `--check`)
- the operator `Deployment` and its `ClusterRole`
- the gateway `Deployment` with its Tailscale sidecar, a projected token with audience `coli-daemon`
  (what it presents to daemons), its `ClusterRole`, and a `Service` whose port is the sidecar's
  ([gateway.md](gateway.md#identity))
- the `coli-tokenreview` `ClusterRole`
- a `ColiOrg` from values
- optionally, the example `NodePool`s

Image tags and chart versions live in `Chart.yaml` and `values.yaml`. Rust dependencies live in
`Cargo.toml`, which Dependabot gets an entry for. Nothing is pinned twice.

## Layout

```text
deploy/
  Cargo.toml            # workspace
  crds/                 # the CRD types (shared by operator and gateway); generates the YAML
  operator/             # reconcilers
  gateway/              # see gateway.md
  chart/                # Helm
  images/               # Dockerfiles: daemon, workspace base
bin/
  gen-crds              # CRD YAML from the Rust types; --check
  kind-up               # a local cluster with everything installed
  e2e                   # the cluster test against kind
```

## Testing

- **Reconcile logic is pure where it can be.** "Desired objects for this `ColiUser`" and "desired
  pod for this `ColiWorkspace`" are functions from spec to objects, unit tested with `cargo test`.
  The tests assert the security properties directly: no API token in a workspace pod, no privilege,
  the creds volume in memory, the projected token's audience, the RBAC rows above.
- **`bin/kind-up`** builds the images, starts a kind cluster, loads the images, and installs the
  chart with a development identity mode ([gateway.md](gateway.md#development-identity)) because
  there's no tailnet inside kind.
- **`bin/e2e`** against that cluster:
  - signs in as two users
  - dispatches a fake issue on a fake runtime as one of them
  - checks that the workspace wakes, runs the session, and sleeps
  - checks that the other user can't see it until it's shared
- CI runs `cargo test` on every change to `deploy/`, and `bin/e2e` on the `multi-user` branch.

## Open questions

- **k3s or kind** for local development? kind is what CI runners support most easily; k3s is closer
  to a small real install. The plan is kind for both until something forces a choice.
- **Daemon sleep.** Worth it at all? Revisit once there are real users and a cost figure.
- **One mirror per repo, or one per node** (a host-path cache)? Measure the clone first.
- **Clouds other than AWS.** The vault's KMS association is AWS-specific. GKE and AKS have
  equivalents; the operator would need one per cloud, or a cloud-neutral key service.
