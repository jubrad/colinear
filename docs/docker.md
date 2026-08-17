# Running the daemon in a container

> **Work in progress.** The container and ssh modes are newer than the rest of colinear and less
> travelled. The local default is unaffected; these paths may still have rough edges.

Agents run *inside the daemon's process*, so a containerized daemon means **containerized agents**:
one image, one filesystem, one set of credentials. That's the appeal — a much smaller blast radius
than an agent with a shell on your laptop — and it's also the cost, because your repo's toolchain has
to be in that image or every check will fail.

The reference [`Dockerfile`](../Dockerfile) is a base to extend: node, git, `gh`, ripgrep, the
`claude` CLI and colinear itself. Add whatever your repos need to build and test.

```bash
docker build -t colinear --build-arg UID=$(id -u) --build-arg GID=$(id -g) .
```

`UID`/`GID` matter on a Linux host: without them the agent creates worktrees your host user can't
delete. (On macOS, Docker Desktop maps ownership for you.)

## The socket, and a macOS gotcha worth knowing first

colinear's TUI talks to the daemon over a unix socket. **Docker Desktop's file sharing cannot
represent a unix socket**, so one created on a bind-mounted path is invisible from both the host
*and* the container — the file appears in `ls` and connecting fails with `ENOENT`.

So put the socket somewhere container-local and keep the bind mount for the files you actually want
on the host:

```bash
docker run -d --name coli \
  -v ~/.local/state/colinear/contexts/docker:/state \   # state.json, logs — readable from the host
  -e COLINEAR_SOCKET=/run/coli.sock \                   # socket off the shared mount
  -v ~/work/cloud:/repos/cloud \
  -v colinear-claude:/root/.claude \                    # named volume: auth + transcripts
  -e LINEAR_API_KEY -e GH_TOKEN \
  colinear coli daemon
```

| host | how you run the TUI |
|---|---|
| **macOS** | inside the container: `docker exec -it coli coli` |
| **Linux** | either — a bind-mounted socket works natively, so the host TUI can connect to `/state/coli.sock` (untested here; the macOS limitation above doesn't apply) |

## Authentication

Subscription auth is the `claude` CLI's own login. On macOS those credentials live in the
**Keychain**, not in `~/.claude` — there is nothing to mount. Log in *inside* the container once
instead:

```bash
docker exec -it coli claude    # then /login
```

With `~/.claude` on a **named volume** the token persists, refresh works (it must be writable — not
`:ro`), and you never extract anything from your host. `~/.claude/projects` lives there too, which is
what makes `r` resume and `s` attach work across container restarts.

This is your subscription authenticating a second client, the same as logging in on another machine.
Whether your plan permits running it as shared team infrastructure is a licensing question worth
checking before it becomes one. API-key billing stays the alternative — and note colinear otherwise
forbids `ANTHROPIC_API_KEY`, because setting it silently moves you off subscription billing.

## Attach, from outside the container

Set `remote` so `s`, `S` and review-doc editing run in the container instead of on your machine:

```json
{ "remote": { "exec": ["docker", "exec", "-it", "coli", "sh", "-lc"], "label": "coli" } }
```

The prefix takes one shell-command argument, which is why `sh -lc` is part of it. Without this,
colinear would try to open a local shell at a path that exists only in the container — see
[remote](remote.md#why-not-just-run-a-local-shell).

With `remote` set, colinear also refuses to start a *local* daemon for that context, and
`coli daemon status|stop` tells you to manage it in the container rather than signalling a pid from
another namespace.

## Other traps

- **Bind-mount I/O on macOS is slow.** Put worktree roots on a named volume if checkout and build
  time matter; at 30 GB per worktree it does.
- **Don't mount the Docker socket into the container.** A daemon that can drive Docker is
  root-equivalent on the host, which throws away the isolation you containerized for.
- The image needs egress to Anthropic, your tracker and GitHub. If you're containerizing for
  containment, an egress allowlist is the other half of the job.
