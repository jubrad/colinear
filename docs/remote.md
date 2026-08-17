# Running the daemon on another machine

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
no code:

```bash
ssh -N -L ~/.local/state/colinear/contexts/vm/coli.sock:/home/you/.local/state/colinear/coli.sock vm
```

Give it a [context](configuration.md#contexts) rather than pointing it at your local socket path: a
context has its own state directory and socket, so a remote daemon can't collide with a local one and
you can run both at once.

```json
// ~/.config/colinear/contexts/vm.json
{
  "remote": { "ssh": "vm" },
  "repos": [{ "name": "cloud", "path": "/home/you/work/cloud" }]
}
```

```bash
coli --context vm
```

`remote.ssh` is whatever you'd type after `ssh` — a host, `user@host`, or an ssh_config alias. Paths
in that config are **the VM's** paths, since that's where agents run.

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
