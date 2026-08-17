# Security & blast radius

colinear dispatches agents that write code and push branches. This page is what they can reach, what they can't, and where your data ends up — read it before pointing it at a repo you care about.

## What agents can touch

**Only repos on the allowlist, and only through worktrees.** `repos` in the config is the whole list. Each task gets `<repo>-worktrees/<ISSUE-KEY>`, cut from `<remote>/<defaultBranch>`. Your checkout is never modified — the main repo only ever sees `git fetch` and `git worktree add`.

**Draft PRs only.** Agents are told not to run `gh pr ready`, and nothing in colinear does it for them. A PR becomes ready when you press `d` in the task view — and `d` refuses while a merge-order dependency hasn't landed (`D` overrides, because colinear can see that a blocker *merged* but never whether it *deployed*).

**Nothing reaches GitHub or Linear unasked.** Review comments are posted by a deterministic `gh api` call after you press `p`, never by an agent — an agent can report a success its own tool call didn't have. Escalation comments need `c`. Issue creation needs `A`. The coordinator agent can propose sub-issues but cannot create them.

## Permissions

An agent inside its worktree can run commands the classifier approves. The worktree is a real
checkout with your git credentials available, so treat a dispatched agent as roughly a colleague
with a shell on your machine and push access to your fork — and then narrow that, with the two
levers below.

### The mode

`agentPermissionMode` sets what headless agents may do on their own (`attachPermissionMode` does the
same for `s` attach sessions). Default `auto`.

| mode | what it means |
|---|---|
| `auto` (default) | a classifier approves routine work; risky or ambiguous calls fall through to you as an allow/deny question on the board |
| `acceptEdits` | file edits and common filesystem commands are automatic; everything else asks |
| `default` | asks about everything not already allowed — safe, and noisy enough that you will notice |
| `plan` | read-only: the agent plans and cannot act |
| `bypassPermissions` | asks nothing. This hands an unattended agent your shell — choose it deliberately or not at all |

An unknown value is a startup error rather than a silent widening.

### Scoping what's allowed

Two levers, both verified to actually refuse:

**1. `denyTools` in colinear's config — operator policy.** Applied to every agent colinear starts,
from a file outside the worktree, so nothing an agent does can loosen it:

```json
"denyTools": [
  "WebFetch",
  "Bash(cat .env:*)",
  "Bash(git push --force:*)",
  "Bash(gh pr merge:*)",
  "Bash(kubectl:*)",
  "Bash(terraform apply:*)"
]
```

Entries are bare tool names (`Read`, `WebFetch`) or Claude Code rule patterns (`Bash(cat:*)`). A
denied tool is removed from the agent's context entirely; a denied pattern refuses that command
while leaving the rest of the tool usable — `Bash(cat:*)` blocks `cat .env` and still allows
`ls -la`.

Mind which denials break colinear's own workflow: blocking `Bash(git push:*)` or `Bash(gh pr
create:*)` means agents can never open the PR that is the whole point.

**2. `.claude/settings.json` in the repo — per-project rules.** Colinear runs agents with
`settingSources: ['project']`, so a repo's own permission rules are loaded and enforced:

```json
{ "permissions": { "deny": ["Read(./.env)", "Read(./secrets/**)", "Bash(cat .env:*)"] } }
```

This is the right home for rules that belong to a codebase rather than to you, and it travels with
the repo for everyone. The caveat: it lives *inside* the worktree the agent is working in. A change
would show up in the diff, but if you want a rule an agent cannot touch, put it in `denyTools`.

Worth knowing: an agent may attempt paths **outside** its worktree — in testing, one tried
`/Users/<me>/.env` before the local file. The worktree is where its work happens, not a sandbox
boundary. Deny rules and the classifier are what stop it, so write path rules absolutely where it
matters.

## Credentials

| secret | where it lives | who reads it |
|---|---|---|
| Claude subscription | the logged-in `claude` CLI | the agent SDK. **Leave `ANTHROPIC_API_KEY` unset** — setting it bills the API instead of your subscription |
| Linear API key | `LINEAR_API_KEY`, or `linearApiKey` in the config file | colinear only |
| GitHub | your existing `gh` auth | `gh` calls colinear makes |

`coli init` prefers the environment variable and won't write a key it found there into the file. If you do put it in the config, that file is plain JSON in your home directory — protect it accordingly.

## What leaves your machine

- **To Anthropic**: issue titles, descriptions, your instructions and guidance, repo contents the agent reads, and diffs — the same as running `claude` yourself in that repo.
- **To Linear**: state changes, assignment, and any comment you explicitly post.
- **To GitHub**: branches you push, draft PRs, and reviews you post.

Everything else stays local: `~/.local/state/colinear/` holds task state, the debug log (which includes diverted stderr), planner chats, coordination channels and attach scripts. The PR review document lives in the review worktree and is never sent anywhere; only the findings you post are.

## Multi-tenancy and isolation

A **context** (`coli --context work`) is a separate config, daemon, store, log and state directory — the clean way to keep a work tracker and a personal one from sharing anything. `COLINEAR_STATE_DIR` overrides the lot, which is what the test suite uses so it can never touch a live daemon.

## Disk

Worktrees are full checkouts and they accumulate — one per task, one per PR reviewed. `coli gc` (or `:gc`) shows what can be reclaimed and removes only what you select; it never touches a worktree with live work, and branches and commits stay in the repo. See [`:gc`](views/gc.md).

## Reporting a problem

Open an issue. If it's a vulnerability rather than a bug, say so in the title and leave out the exploit details until we can talk.
