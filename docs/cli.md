# CLI and the daemon

`coli` is two processes: a **daemon** that owns the dispatcher, the task store, persistence, PR polling and the Linear sweeps, and a **TUI** that mirrors its state over a unix socket (`~/.local/state/colinear/coli.sock`). Running `coli` starts both — the daemon only if one isn't already up.

Agents therefore outlive the UI. Close the terminal, quit with `q`, or hit `R` to restart the frontend on a fresh build; the daemon keeps working and the board reattaches to live state. The mirror is kept current by change data capture: the client hydrates from a snapshot and follows a versioned delta stream, re-snapshotting if it ever misses one.

| command | what |
|---|---|
| `coli` | TUI (starts a daemon if needed) |
| `coli --context NAME` | ...against a different config + state. `-c NAME` works too, on any command |
| `coli daemon` | run the daemon in the foreground |
| `coli daemon status` | pid + socket, or "no daemon running" |
| `coli daemon stop` | stop it — live agents abort and resume with `r` |
| `coli gc [--yes] [--older-than N]` | reclaim worktree disk; prints what it would remove and stops there without `--yes`. Works with the daemon down |
| `coli contexts` | list contexts: config path, state dir, and which have a daemon running |
| `npm run doctor` | env sanity: `claude` CLI, `gh` auth, Linear key, repos |

Only the daemon dispatches agents, so stopping it is the one thing that interrupts work.

## `coli init`

Writes the first config: tracker, key, scope, repos. It validates the key by using it, offers the
scopes that come back, suggests the repository you are standing in and reads its default branch.

```bash
coli init                                  # interactive
LINEAR_API_KEY=… coli init --yes           # key from the env, repo from $PWD, no questions
```

An existing config is never overwritten without a yes, and a key found in the environment is not
written into the file.

## `npm run doctor`

Checks what colinear can't fix for you: the `claude` CLI, `gh` auth, the tracker key (by making a
real request), and that the configured repos exist. Run it after `init`, and when something is off.

