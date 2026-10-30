# The gateway, identity and the protocol

The gateway is the one endpoint people connect to. It finds out who you are, makes sure you have a
daemon, and connects you to it, or to someone else's daemon for an item they shared with you. It
also serves the web UI. It holds no user data and no credentials. It's a router with an identity
check.

Rust, in the same Cargo workspace as the operator ([operator.md](operator.md#layout)).

## Identity

**Tailscale first.** The gateway runs behind `tailscale serve`, in a sidecar in the gateway's pod.
For every request from a tailnet user, `serve` adds headers naming them: `Tailscale-User-Login`
and `Tailscale-User-Name`. So the gateway gets a verified identity without storing a password, and
anyone off the tailnet can't reach it at all.

Three rules make the headers trustworthy:

- **The gateway listens on loopback only.** The sidecar is the only thing that can reach it, so a
  forged header can't arrive by another route. The chart's `Service` points at the sidecar's port,
  not the gateway's.
- **Requests without a user are refused.** Tagged devices (servers, CI) have no user identity, and
  `serve` sends no headers for them. Machine access, if it's ever wanted, gets its own design.
- **Browser requests must come from the gateway's own origin.** A browser attaches the user's
  tailnet identity to any request it makes, including one a hostile page starts. So a WebSocket
  upgrade or any state-changing request (`POST`) whose `Origin` header is present and isn't the
  gateway's own host is refused. The TUI sends no `Origin`.

On a request:

1. The login is checked against `ColiOrg.users.allow` (logins, or `*@domain`). Refused if it's not
   there.
2. The gateway makes sure a `ColiUser` exists for it, creating one on first sign-in.
3. It waits for `status.daemon.ready`. The first sign-in takes as long as a pod start, and the client
   shows a spinner for it. After that, the daemon is always running
   ([operator.md](operator.md#coliuser)).

**OIDC later.** An org without Tailscale wants an OIDC login (Google, Okta, GitHub). The gateway is
the only thing that changes: it would verify a token rather than trust a header, and everything
behind it still receives one identity per connection.

### Development identity

kind has no tailnet. The chart's `gateway.devIdentity: true` makes the gateway take the user from an
`X-Coli-Dev-User` header instead. It refuses to start that way unless it's bound to loopback and the
chart also sets `gateway.iUnderstandThisIsInsecure: true`, and it logs a warning on every request.
`bin/kind-up` sets both; nothing else should.

## Routes

| route | what |
|---|---|
| `GET /` | the web UI ([webui.md](webui.md)) |
| `GET /v1/connect` (WebSocket) | your daemon, as its owner |
| `GET /v1/shared` | items shared with you, from the `ColiShare` index ([sharing.md](sharing.md#the-shared-list)) |
| `GET /v1/view/<user>/<item>` (WebSocket) | someone else's daemon, as a viewer of one item |
| `POST /v1/fork/<user>/<item>` | fork someone's item into your account: the gateway fetches the bundle from the owner's daemon and hands it to yours ([sharing.md](sharing.md#forks)) |
| `GET /v1/oauth/linear/callback` | the end of a Linear sign-in; the code goes to the daemon that started it ([credentials.md](credentials.md#linear)) |
| `GET /v1/org-config` | the org config layer, read-only, for daemons outside the cluster ([config.md](config.md#daemons-outside-the-cluster)) |
| `GET /v1/costs` | per-user spend, for org admins only ([sharing.md](sharing.md#costs)) |
| `GET /healthz` | |

## Protocol

Today the TUI and daemon speak NDJSON over a unix socket: a `hello` with the protocol version, the
config and a snapshot, then a change log, plus commands in the other direction (`core/protocol.ts`).
The mirror-follows-a-log design in DESIGN.md is what makes that robust, and it carries over
unchanged.

What changes:

- **Transport.** The daemon also listens on a WebSocket. Each WebSocket message is one of today's
  frames. The unix socket stays for single-user mode.
- **Identity.** On every connection the gateway sends a first frame of its own,
  `{ t: 'viewer', login, displayName, role: 'owner' | 'viewer', item?, admin }`, before relaying
  anything from the client. `admin` is true for logins in `ColiOrg.users.admins`. The daemon
  trusts the frame only from the gateway: the connection presents the gateway's projected
  service-account token (audience `coli-daemon`), and the daemon's `TokenReview` must name the
  gateway's service account in `coli-system`. A runner's token, with the same audience, names a
  different account and gets the runner protocol instead.
- **Scope.** A `viewer` connection gets a snapshot containing only the shared item, and only the
  commands its share allows ([sharing.md](sharing.md#what-a-viewer-gets)). The daemon enforces
  that. The gateway doesn't, because the gateway shouldn't need to understand commands.
- **No secrets in `hello`.** It sends the config **redacted**: no tracker key, no token, nothing from
  the credential store. See [below](#the-thin-client).

The gateway relays frames without reading them, apart from its own `viewer` frame. That keeps it
small, and it means a new daemon command needs no gateway change.

## The thin client

The TUI does more than display today. Some views call the tracker directly with a key from the
config they were sent, run `gh`, or touch paths that only exist on the daemon's machine. Over a
network, and with someone else's daemon, all of that has to move behind the daemon.

| what the TUI does today | where | becomes |
|---|---|---|
| tracker reads and writes (`providerFor`) | `IssuesView`, `ProjectsView`, `ProjectView`, `taskActions`, `ChatView`, `ConfigView`, `app.tsx`, `index.tsx` (`coli issue add`) | a `provider` command family: the daemon makes the call and returns the result |
| filing a split plan (`fileSplit`, `childIssues`) | `TaskView` | a daemon command, like the auto-split path already is |
| `gh pr ready` | `TaskView` | a daemon command; **owner-only**, since it's a GitHub action |
| `s` / `S` attach, the plan chat's attach | `attach.ts` (`existsSync` on the worktree), `ChatView` | a pty over the connection ([runner.md](runner.md#attach)) |
| `e` on a review doc, the editor and shell handoffs | `index.tsx` | the daemon sends the file, the TUI edits a local temp copy and sends it back on save |
| the daemon log's size | `LogsView` | already streamed over the socket in remote mode; the local stat goes |
| the config | sent whole in `hello` | sent redacted; `:config` edits go through a command |

Two things stay in the client on purpose. Opening a URL (`taskActions`, `ReviewsView`) should
happen on the machine with a browser. Notifications already do the same.

Each row works in single-user mode before anything depends on it. The first row also fixes the
remote-mode gap [remote.md](../../docs/remote.md#known-gaps) admits to.

## The CLI

A context points at a gateway instead of a socket:

```json
// ~/.config/colinear/contexts/team.json
{ "remote": { "gateway": "https://coli.example-tailnet.ts.net" } }
```

```bash
coli --context team
```

There's no login step: the request goes out over the tailnet, so `serve` knows who sent it. With
OIDC, `coli login --context team` would do a device-code login and keep the token in the OS keychain.

The TUI doesn't reconnect when its daemon goes away today. Through a gateway, a dropped relay is
more likely than a dead daemon, so reconnecting (with a fresh snapshot, as a new connection always
gets) is part of the gateway steps in the work order.

## Open questions

- **Tailscale sidecar or the Tailscale Kubernetes operator?** The sidecar is the simplest thing that
  definitely passes identity headers. The operator's ingress may work too; check before choosing.
- **One gateway replica or several?** It's stateless apart from WebSocket relays, so several work.
