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
| `coli daemon socket` | print this context's socket path — what an ssh forward has to target ([remote](remote.md)) |
| `coli gc [--yes] [--older-than N]` | reclaim worktree disk; prints what it would remove and stops there without `--yes`. Works with the daemon down |
| `coli contexts` | list contexts: config path, state dir, and which have a daemon running |
| `coli backup [--out FILE]` | one encrypted archive holding conversations, work in progress, state and config — [below](#coli-backup-and-coli-restore) |
| `coli restore FILE` | put it back on another machine (`--dry-run`, `--list`, `--clone`) |
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

## `coli backup` and `coli restore`

A new computer. One archive, and everything colinear knows how to do for you carries over.

```bash
coli daemon stop                 # its state file is written every few seconds
coli backup                      # asks for a passphrase → coli-backup-<host>-<date>.tar.gz.enc
# … on the other machine, same colinear version, same OS …
coli restore coli-backup-….tar.gz.enc --dry-run
coli restore coli-backup-….tar.gz.enc
```

### What is in it

Four things, in order of how hard they are to get back:

- **conversations** — the Claude Code transcripts behind every `r` and `c`. Claude Code files them
  per working directory, which is why they are the part a plain `rsync` of your config would miss;
- **work in progress** — each worktree as a git bundle of the commits that are not upstream, a
  patch of what is uncommitted, and a tar of what is untracked;
- **state** — the store snapshot, plans and channels, for every context;
- **config** — every context's config file.

Not the repositories. A monorepo clone dwarfs all of the above and is one command to recreate; the
manifest records each repo's remote URL, so restore either tells you the exact `git clone` to run
or runs it for you with `--clone`.

### It is encrypted, and that is not optional by accident

This archive is the most concentrated secret colinear can produce: every context's config, tracker
API key included, the transcript of every conversation an agent has had, and git bundles of commits
nobody has pushed. It is also, by design, a file you carry somewhere else. So it is encrypted by
default, and the plaintext path is the one you have to ask for.

`coli backup` asks for a passphrase and confirms it. The archive is encrypted with a fresh random
256-bit key; the passphrase only wraps *that* key, through scrypt, and the wrapped key rides in the
archive's header. So the bulk cipher gets real entropy rather than whatever you typed, and one file
is all you move.

**The passphrase is stored nowhere** — not in the archive, not on the machine that wrote it. Lose it
and the backup is gone, for you and for everyone else. Put it in your password manager when you make
the backup, not later.

For anything without a terminal — a scheduled backup, CI — the passphrase comes from
`--passphrase-file FILE` (first line) or `COLINEAR_BACKUP_PASSPHRASE`. Both work on `coli restore`
too, and restore prompts when it has a terminal and the archive needs one.

```bash
coli backup --passphrase-file ~/.config/colinear/backup.key   # unattended
coli backup --no-encrypt                                      # warns, then writes it in the clear
```

An encrypted archive is authenticated as well as encrypted: a truncated or edited one fails with
`archive failed its integrity check` rather than unpacking into something subtly wrong, and a
passphrase that does not fit says `wrong passphrase` instead. `coli restore --list` needs the
passphrase for the same reason everything else does — the manifest is inside.

### Why worktrees are recorded rather than copied

A worktree is not a self-contained directory — its `.git` is a *file* pointing into the parent
repository, so a copied one is inert on the far side. Recording (bundle, patch, untracked) instead
is both correct, because `git worktree add` on the new machine produces a real registered worktree,
and very much smaller: **282 GB of checkouts came to an 18 MB archive** on the machine this was
written for.

That size is not compression, it is knowing what to leave out. `target/`, `.venv/`,
`node_modules/`, `dist/` — everything the repository's own `.gitignore` declares uninteresting is
excluded for free, which beats any list colinear could carry, because it is the list the repository
already maintains. Untracked files above `--max-file` (64M) are named in the output rather than
carried, so nothing large disappears quietly.

The two exceptions are colinear's own scratch files, `.colinear-review.md` and
`.colinear-subtasks.md`. They are git-excluded so no agent commits them, which would also have hidden
them here — they are added back by name, because a review's findings are not a build artefact.

### Restoring

Restore refuses across colinear versions and across operating systems. That is the bargain that
keeps it honest: a patch and a transcript both assume the thing that wrote them.

### A different username

The one thing that really does differ between two machines is **where home is**, and restore
rewrites every absolute path that crosses: the config, the board's worktree paths in `state.json`,
plans and channels that name a checkout in prose, the *name* of each transcript directory — and the
transcripts themselves.

That last one is the part that is easy to miss. A transcript directory is named after the working
directory it belongs to, encoded, so a conversation restored under its old name is filed against a
path that no longer exists and `c` opens an empty session. But the name is only half of it: **every
record inside carries the absolute directory it happened in**, along with the absolute path of every
file a tool read or wrote and every command that named one. In one 49 MB transcript here that is
13,834 of 18,966 records. Restored with the name fixed and the contents left alone, the conversation
loads and then talks about another user's files.

So the contents are rewritten too — by extension (`.json`, `.jsonl`, `.md`, `.txt`) rather than by
sniffing, because a git bundle and an sqlite database are in the same tree and a "does this look
like text" guess that is wrong once corrupts one of them. Measured on the real transcripts on this
machine: 49 MB in 33 ms, every record still parsing, no mention of the old home left.

Nothing is overwritten in place: anything already there is moved aside as `<name>.before-restore`
first, an existing worktree is left alone and reported, and transcripts merge rather than replace.
`--dry-run` prints the whole plan and writes nothing; `--list` reads just the manifest.

The daemon must be stopped for both commands — it rewrites `state.json` every few seconds, so a
backup taken while it runs can catch the file mid-write.

### The round trip is a gate

`bin/check` builds a complete fake installation — a repository with an upstream, a worktree with
unpushed commits, uncommitted edits, untracked files, a build directory that must not travel, a
review document that must — backs it up, restores it onto a **second home directory with a
different path**, and asserts on what came out. This is the one feature where a typecheck proves
nothing, because the whole point is that the first machine can be thrown away afterwards.

## `coli demo`

```bash
coli demo
```

Writes a `demo` context and launches into it: a fabricated board, scripted agents, no network,
nothing billed. See [demo mode](demo.md).

## `coli issue add`

File an issue without leaving the shell. Works against any provider, and it's the way into the
sqlite tracker that doesn't cost an agent call:

```bash
coli issue add "Add a rollback path" --priority 2
coli issue add "Write the down migration" --parent LOC-1 --desc "reverse of the forward one"
```

`--scope KEY` picks the team/project/scope when you have more than one; otherwise it uses your
configured one.

## `npm run doctor`

Checks what colinear can't fix for you: the `claude` CLI, `gh` auth, the tracker key (by making a
real request), and that the configured repos exist. Run it after `init`, and when something is off.

