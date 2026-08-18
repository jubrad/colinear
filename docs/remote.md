# Running the daemon on another machine

> **Work in progress.** ssh and container modes are newer than the rest of colinear and less
> travelled; expect rough edges. The local default is unaffected.

**Local is the default and nothing here is required.** Leave `remote` unset and colinear behaves
exactly as it always has.

Putting the daemon on a VM buys three things: agents use the VM's CPU and disk (a 30 GB worktree per
task stops being your laptop's problem), the lid can close without interrupting anything, and the
"colleague with a shell" from [security](security.md) is on a disposable box rather than your
machine.

The cost is real too: `claude` must be logged in **on the VM** for subscription auth, and `gh`
authenticated there as well.

## The tunnel

colinear speaks NDJSON over a unix socket, and OpenSSH forwards unix sockets, so the transport needs
no protocol work — only for the socket to exist at the path this context looks in.

Set `"forward": true` and colinear opens it for you:

```json
// ~/.config/colinear/contexts/vm.json
{
  "remote": { "ssh": "vm", "forward": true },
  "repos": [{ "name": "cloud", "path": "/home/you/work/cloud" }]
}
```

```bash
coli --context vm
```

Give it a [context](configuration.md#contexts) rather than pointing it at your local socket path: a
context has its own state directory and socket, so a remote daemon can't collide with a local one and
you can run both at once.

### What forwarding actually does

When the context's socket has nothing behind it, colinear asks the far side where its socket lives
(`ssh vm 'coli daemon socket'` — the answer depends on that machine's `HOME` and context, so it is
asked rather than guessed), then runs the equivalent of:

```bash
ssh -N -L ~/.local/state/colinear/contexts/vm/coli.sock:/home/you/.local/state/colinear/coli.sock vm
```

Set `"socket"` if you would rather name the far-side path than have it asked for:

```json
{ "remote": { "ssh": "vm", "forward": true, "socket": "/home/you/.local/state/colinear/coli.sock" } }
```

The tunnel is a child of the session that opened it, and goes down with it. That is deliberate: a
forward left running after the UI exits leaves a socket that accepts connections with nothing behind
it, which is worse than no socket at all. If the tunnel dies mid-session the connection drops the way
any daemon disconnect does, and the reason is in `colinear.log`.

Forwarding needs `ssh`. A generic `exec` prefix ([docker](docker.md), `kubectl`) has no equivalent,
so `"forward": true` without `"ssh"` is refused at config load rather than failing later as a
connect timeout.

You can still run the tunnel yourself — leave `forward` unset and use the `ssh -N -L` line above.
`coli daemon socket` prints the path either side expects.

`remote.ssh` is whatever you'd type after `ssh` — a host, `user@host`, or an ssh_config alias. Paths
in that config are **the VM's** paths, since that's where agents run.

`ssh` is sugar for the general form, `exec`: a command prefix that takes one shell-command argument.
That's what makes containers ([docker](docker.md)) and, later, `kubectl exec` the same mechanism
rather than three special cases:

```json
{ "remote": { "exec": ["ssh", "-t", "vm"] } }
{ "remote": { "exec": ["docker", "exec", "-it", "coli", "sh", "-lc"], "label": "coli" } }
```

Start the daemon over there once, the normal way:

```bash
ssh vm 'cd ~ && coli daemon'    # or run it under systemd/tmux so it survives logout
```

## What changes in the UI

Almost nothing, deliberately — but five things had to stop assuming the daemon's disk is yours:

| | how it works remotely |
|---|---|
| `s` attach | `ssh -t <host> cd <worktree> && claude --resume …` — the transcript lives on the daemon's host |
| `S` shell | `ssh -t <host> cd <worktree> && exec $SHELL -l` |
| review doc `e` | `ssh -t <host> $EDITOR <path>` |
| `:logs` | the daemon's tail comes over the socket. The header also shows your **local** client log, which is where this process's diverted stderr (React warnings) still goes |
| `:chan` | channel history comes over the socket |
| notifications | raised on the machine with a screen, not on the VM |

The handoff messages name the host (`shell in /w/CLO-1 on vm`), so you always know which machine you
just landed on.

## Why not just run a local shell?

Because it would sometimes work. If both machines use the same layout — and they often do — a local
`$SHELL` with `cwd` set to a VM path drops you in a **same-named directory on the wrong host**, with
no error. That's the one failure mode worth engineering against, and it's why `remote` is a config
flag rather than something inferred.

## Known gaps

- **`:plan` and `n` still run in the TUI process**, so they use your laptop's network and expect the
  repo to exist locally. Remote makes that pre-existing debt visible; moving them behind the daemon
  is the fix.
- **The daemon sends its config, including the API key, in the handshake**, because views make
  provider calls client-side. Over SSH that's encrypted, but the cleaner shape is proxying provider
  calls through the daemon so the key never leaves the VM.
- Nothing supervises the tunnel. If ssh drops, the client stops receiving deltas — restart both.
- With `remote` set, colinear refuses to start a local daemon for that context, and
  `coli daemon status|stop` won't signal a pid that belongs to another machine's namespace — it
  tells you the command to run over there instead.
