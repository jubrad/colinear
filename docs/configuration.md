# Configuration

`~/.config/colinear/config.json` (legacy `~/.colinear.json` also works); `LINEAR_API_KEY` env var covers the key. View and edit live with `:config` — `e` opens `$EDITOR`, seeds the file from current settings on first use, and changes hot-apply on return. A config file that exists but doesn't parse is a startup error rather than a silent fallback to defaults.

```json
{
  "linearApiKey": "lin_api_...",
  "repos": [
    {
      "name": "cloud",
      "path": "~/work/cloud",
      "description": "the control plane: API servers, background workers, infra",
      "defaultBranch": "main",
      "worktreeRoot": "~/work/cloud-worktrees",
      "checks": [{ "name": "fmt", "cmd": "bin/fmt --check" }]
    },
    { "name": "engine", "path": "~/work/engine", "pushRemote": "my-fork" }
  ],
  "team": "CLOUD",
  "concurrency": 3,
  "model": "sonnet",
  "guidance": {
    "general": [
      "PRs should solve the problem at hand simply and clearly.",
      "Code is debt: don't write code that isn't needed to solve and validate the problem."
    ],
    "review": "Flag missing tests, but don't ask for tests that only restate the implementation."
  },
  "prSignoff": "_written by claude on behalf of @jubrad_",
  "prSignoffScope": "body",
  "notifications": true,
  "stateSync": true,
  "ciAutofix": true,
  "autoRebase": false,
  "retentionDays": 30,
  "worktreeRetentionDays": 7,
  "attachPermissionMode": "auto",
  "terminal": "ghostty",
  "tickMs": 1000
}
```

### Config reference

Every key is optional except a Linear API key (config or env). Defaults are what you get by leaving a key out.

| key | default | what |
|---|---|---|
| `provider` | `"linear"` | which issue tracker this context talks to: `linear`, or `sqlite` for a local one. [Details](#issue-providers) |
| `sqlitePath` | `<state dir>/local.db` | where the sqlite tracker's file lives |
| `demo` | `false` | scripted agents, fabricated board, no network. [Details](demo.md) |
| `linearApiKey` | `$LINEAR_API_KEY` | Linear personal API key. Leave it out of the file and export the env var if you'd rather not have it on disk |
| `repos` | one repo (see below) | the allowlist — agents only ever touch these, and only through worktrees. First entry is the default. [Details](#repos) |
| `team` | your assigned issues | Linear team key (`"CLOUD"`) to browse, or `"all"` for every team. `--team CLOUD` / `--team all` override it for one run, and the last team picked with `t` is remembered |
| `concurrency` | `3` | agent sessions running at once. Above ~5 you start hitting subscription rate limits |
| `model` | Claude Code's default | model for agents (`"opus"`, `"sonnet"`, `"fable"`, `"haiku"`). Overridable per dispatch (`c`) and per task (`m`) |
| `guidance` | none | standing house rules injected into agent prompts, globally or per prompt. [Details](#guidance) |
| `prSignoff` | none | markdown appended to what colinear posts on a PR, so the author knows what wrote it. String or list of lines. An empty comment never becomes a signoff-only comment |
| `prSignoffScope` | `"all"` | `"all"` signs the review body and every inline comment; `"body"` signs only the body, so a review with six findings carries one attribution instead of seven |
| `notifications` | `true` | macOS notifications for the events that want you: a task needs input, finishes or fails, a CI-fix or rebase session goes out, a pre-review is ready. Click-through to the PR/issue with `terminal-notifier` installed |
| `stateSync` | `true` | move Linear states automatically: dispatch → In Progress, first PR → In Review |
| `ciAutofix` | `true` | dispatch a fix session when a task's PR checks go red (one per red rollup, re-armed when it goes green) |
| `autoRebase` | `false` | default for [auto-rebase on conflict](#auto-rebase); the `m` modal overrides it per task |
| `autoDispatchSubs` | `false` | when a tracking parent gains a sub-issue nobody has started, dispatch it. [Details](#new-sub-issues) |
| `retentionDays` | `30` | how long finished work stays on the board. [Details](#retention-and-disk) |
| `worktreeRetentionDays` | `7` | how long a finished task's worktree is kept before `coli gc` offers it. [Details](#retention-and-disk) |
| `experimental` | `false` | master switch for unfinished features. Nothing in `experiments` runs unless this is true. [Details](#experimental-features) |
| `experiments` | none | per-feature opt-in: `{ "coordination": true }`, or a list of names |
| `agentPermissionMode` | `"auto"` | what headless agents may do on their own: `auto`, `acceptEdits`, `default`, `plan`, `bypassPermissions`. [Details](security.md#the-mode) |
| `denyTools` | none | tools and command patterns no agent may use, applied as policy from outside the repo. [Details](security.md#scoping-whats-allowed) |
| `attachPermissionMode` | `"auto"` | permission mode for `s` attach sessions: `auto` (classifier gates risky commands), `acceptEdits`, `bypassPermissions`, `default`. Headless agents always run `auto`; classifier-blocked commands surface on the board as allow/deny questions |
| `autoDispatchLabels` | unset | issues carrying any of these labels dispatch themselves — swept every minute, capped at 3 per sweep, through the normal pipeline (triage included). The label is the opt-in: `["agent"]` makes labelling an issue in the tracker the dispatch button. Confined to your `team` unless `autoDispatchScope` says otherwise. See [dispatch](dispatch.md#label-dispatch) |
| `autoDispatchScope` | `"team"` | where the label sweep looks. `"team"` confines it to the configured `team` — labels are not namespaced, and a workspace-wide sweep acting on another team's vocabulary would self-assign their issues. `"all"` is the explicit opt-in for single-team workspaces or a deliberate cross-team label. No `team` configured and scope `"team"` = no sweep, said once |
| `editor` | unset | what `e` opens — answer forms, review documents, the config itself. Beats `$EDITOR` (the precedence git gives `core.editor`); flags welcome: `"code --wait"`. Unset falls through to `$EDITOR`, then `vi` |
| `remote` | unset (local) | run this context against a daemon on another machine: `{"ssh": "vm"}`. Add `"forward": true` and colinear opens (and owns) the ssh tunnel to its socket; `"socket"` names the far-side path instead of asking for it. [Details](remote.md) |
| `terminal` | in-place | where `s` attaches: unset hands over the current terminal (recommended), `"ghostty"` / `"terminal"` open an external window |
| `tickMs` | `1000` | UI refresh tick. Raise it (e.g. `2000`) if your terminal or multiplexer flickers |

Legacy single-repo keys still work in place of `repos`: `repo`, `defaultBranch`, `worktreeRoot`, `checks`.

Environment: `LINEAR_API_KEY`, `COLINEAR_CONTEXT` ([contexts](#contexts)), `COLINEAR_STATE_DIR` (points state, socket, pidfile and log somewhere else — used to isolate test runs), `EDITOR`, `SHELL`.

### Repos

Agents only ever touch repos on this list, and only through worktrees under each repo's `worktreeRoot` — your working copy is never modified (the main checkout only sees `git fetch` and `git worktree add`). The first entry is the default; `c` (custom dispatch) and `m` (edit task) pick per task, and triage can re-route an issue on its own.

| key | default | what |
|---|---|---|
| `path` | — | required; `~` expands |
| `name` | basename of `path` | how the repo is named in the UI and in dispatch modals |
| `description` | none | **what lives here.** Triage reads these to route each issue to the right repo, so write them honestly |
| `defaultBranch` | `"main"` | branch worktrees are cut from |
| `remote` | `"origin"` | upstream **git remote name** — worktree base, and the repo PRs land in |
| `pushRemote` | = `remote` | remote branches are pushed to. Set your fork here for a fork workflow (`"jubrad"`) |
| `prBase` | = `defaultBranch` | branch PRs are opened against |
| `worktreeRoot` | `<path>-worktrees` | where per-issue worktrees are created |
| `checks` | none | commands run in the worktree after the work pass: `[{ "name": "fmt", "cmd": "bin/fmt --check" }]`. Output lands on the task detail view |

`remote` / `pushRemote` are git remote names as they appear in `git remote -v` for that repo (`"mz"`, `"jubrad"`) — not `owner/repo` slugs. In fork mode agents skip stacked PRs, since those would require pushing to the upstream.

### Guidance

Standing house rules for agents — the things that are true of every PR you'd merge, so you don't retype them per issue. Either one block that reaches every agent:

```json
"guidance": ["PRs should solve the problem at hand simply and clearly."]
```

or a map, where each scope's text is **added to** `general` for that one kind of work:

```json
"guidance": {
  "general": ["applies to every agent"],
  "triage":  "scoping an issue",
  "work":    "implementing an issue",
  "review":  "reviewing someone else's PR",
  "plan":    "project planning chat"
}
```

Every value takes a string or a list of lines. Precedence: per-task instructions (`m`, or `c` at dispatch) outrank guidance, and repo-specific conventions still belong in that repo's `CLAUDE.md`, which agents read anyway.

### Retention and disk

Two windows, deliberately different numbers — a checkout is exactly what you want the day a task lands, long after the card stops being interesting.

- `retentionDays` (default `30`, `0` keeps everything) — how long finished work stays on the board. Past it, done and cancelled tasks and settled reviews are forgotten; never anything with a live agent, a pending question, an open PR, or an error, however old. It's also the window the header's `Tokens/30d ($…)` figure covers, so the number and the board always agree.
- `worktreeRetentionDays` (default `7`) — how long a finished task's **worktree** survives before `coli gc` / `:gc` offer it for removal. Nothing is ever removed without you asking. `--older-than N` overrides it for one run.

### New sub-issues

Creating a sub-issue and spending an agent on it are separate statements, so by default they stay separate: `A` on a proposal or split plan creates the issues, `D` creates **and** dispatches, and `u` on the parent dispatches whatever is sitting there. A sub-issue you make in Linear yourself appears on the parent within a minute and waits.

`autoDispatchSubs` changes that for tracking parents: any sub-issue that colinear has no task for **and** that nobody has started in Linear gets dispatched on the next sweep. The `m` modal sets it per parent (`config default` / `auto-dispatch` / `leave them`), which is the useful granularity — one family running itself while the rest don't.

Three deliberate limits:

- **Linear state is the guard**, not "do we have a task". A sub-issue that was worked months ago and later dropped from the board by `retentionDays` is `started` or `completed` in Linear, so it can never be resurrected by the sweep.
- **Five per sweep.** Nobody is watching a 60-second timer, and a bulk import shouldn't assign twenty issues to you at once; the rest follow a minute later.
- **Auto-dispatched sub-issues get triaged.** `u` and `D` skip triage because you looked at them first; these arrive with no human in the loop, so triage stays on to catch the too-big and under-specified ones.

### Auto-rebase

When GitHub reports a PR **conflicting** with its base, colinear can dispatch a session that rebases it: resolve conflicts, run the linters and nearby tests, `push --force-with-lease`. `autoRebase` is the default (`false`); the `m` modal sets it per task (`config default` / `auto-rebase` / `leave it`), and `b` rebases on demand whatever the setting says.

One attempt per conflict, re-armed once the PR is mergeable again. A conflict GitHub hasn't finished computing (`UNKNOWN`) never triggers one. The card keeps its column and shows a blinking dot — green rebasing, amber fixing CI — since maintenance on an open PR isn't the feature being rewritten.

### Issue providers

Colinear talks to an issue tracker through one interface (`core/provider.ts`) with a **capability descriptor**, rather than assuming Linear's model everywhere. `:config` names the provider, what it calls a scope (team / project / repo), and anything it can't do.

Capabilities exist because the trackers genuinely differ — GitHub Issues has no priority field, no "blocks" relation and only open/closed. Where one is missing the feature switches off rather than breaking: no `workflowStates` means `stateSync` never fires, no `blockers` means nothing parks as ⛓ blocked, no `priority` means the column disappears, no `branchNames` means colinear derives a safe branch from the identifier.

**Linear** supports all of it. **sqlite** is a local tracker in a file — issues, sub-issues,
blocking relations, projects, states, priorities and comments, with no account and no network. It's
how you try colinear in thirty seconds, it's what the demo board runs on, and it's the second
implementation that keeps the interface honest. Its one gap is `branchNames`: there's no upstream to
supply one, so colinear derives a safe branch from the identifier (`LOC-2` → `loc-2`).

It needs `node:sqlite` — Node 24+, or Node 22 with `--experimental-sqlite`. The module is required
lazily inside the provider, so Node 20 keeps working for everyone else.

File issues into it from the shell:

```bash
coli issue add "Add a rollback path"                  # LOC-1
coli issue add "Write the down migration" --parent LOC-1
coli issue add "Ship it" --priority 2 --desc "after the migration lands"
```

Because a **context** is already a config plus its own daemon and store, the natural way to run two trackers is one context each — which also keeps their issue ids from ever meeting in one store.

One requirement any adapter has to meet: `identifier` is load-bearing beyond display. It names branches, worktree directories and coordination channels, and PR matching looks for it in branch names and titles — so it has to be short, unique across the repos in play, and safe in a path and a git ref.

### Experimental features

Features that work but aren't settled — the shape, the token cost or the prompt discipline may still change, and they can affect what agents do. Each needs two switches:

```json
"experimental": true,
"experiments": { "coordination": true }
```

The master switch is separate so one line turns everything experimental off when something misbehaves, without you having to remember which features you'd enabled. Naming a feature without it — or naming something that isn't an experiment — is written to the debug log rather than silently ignored, so a feature never quietly fails to run.

| experiment | what |
|---|---|
| `coordination` | **Family coordination channels, and coordinator sessions for tracking parents.** Sub-issue agents in one family share an IRC-style channel (`#CLO-67`) through in-process MCP tools: `channel_read` (only what's new since that agent last read) and `channel_post` (identity stamped at spawn — an agent can't pose as a sibling or reach another family's channel). They're prompted to claim scopes, announce architectural decisions, flag shared resources they're using, and read before opening a PR. `:chan` lists channels, `:chan CLO-67` tails one with an input box — your message reaches every agent in that family at its next read. Issues in a Linear **project** also share a project channel (`#proj-cloud-migration`) — the agents you'd otherwise never hear from, different families on the same release — and `M` in `:project NAME` broadcasts to it. The read/post tools take a `scope` whose options are exactly the channels that session is in, so an agent can pick between its family and its project but can't reach a family it isn't part of. A **tracking parent** — an issue whose work happens in its sub-issues — becomes coordinatable: `M` a message to it (or `r`) starts a *coordinator* session that can read the family's live state, relay instructions to a sibling's agent, cancel one, and propose new sub-issues. It writes no code and gets no checkout. It also **cannot create Linear issues**: proposals land on the parent card and wait for your `A`. Full design, storage layout and deferred work: [COORDINATION.md](../COORDINATION.md) |

Turning one on changes the daemon's behavior, so it needs `coli daemon stop && coli`, not just `R`.

### Contexts

A context is one config file plus its own state — **separate daemon, socket, task store and log**. Use one per Linear workspace, team, or machine role; two can run side by side without either seeing the other's tasks.

```bash
# ~/.config/colinear/contexts/oss.json
coli --context oss          # or -c oss, or COLINEAR_CONTEXT=oss coli
coli contexts               # what exists, where, and which have a daemon up
```

```json
{
  "team": "OSS",
  "concurrency": 1,
  "repos": [{ "name": "colinear", "path": "~/work/colinear" }]
}
```

A context **layers over the default config**: keys it doesn't set are inherited, so shared settings (key, guidance, signoff) get written once. Top-level keys replace wholesale rather than merging — a context that sets `repos` gets exactly those repos.

Everything downstream follows the context: the daemon it starts or attaches to, `state.json`, the debug log, `coli gc`, and `:config`'s `e`. The board's header shows `(ctx oss)` next to the repo whenever you aren't in the default one, and `coli daemon status` names it — "no daemon running" is otherwise confusing when the real reason is that you're pointed at a different context. Naming a context with no config file is an error, not a quiet fallback to the default: dispatching into the wrong workspace is not a recoverable mistake.

## Where the config lives

`~/.config/colinear/config.json`, or `~/.colinear.json`. A [context](#contexts) reads
`~/.config/colinear/contexts/<name>.json` layered over it.

`coli init` writes the first one. `:config` shows the resolved settings with the key masked, names the
provider and its capabilities, and `e` opens the file in `$EDITOR` — changes apply when you come back.
A file that exists but doesn't parse is a startup error, not a silent fall back to defaults.

## Custom views

Drop JSON in `~/.config/colinear/views/`, then `:reload`:

```json
{
  "name": "cloud-bugs",
  "aliases": ["cb"],
  "describe": "unowned CLOUD bugs",
  "filter": { "team": "CLOUD", "labels": ["Bug"], "assignee": "any", "project": null },
  "columns": ["issue", "priority", "title", "labels"],
  "sort": "priority"
}
```

`filter`: `team`, `labels[]`, `state[]` (workflow types), `assignee` (`me`/`any`), `project` (`null` = no project, or a name).

## Files on disk

| what | where |
|---|---|
| config | `~/.config/colinear/config.json` |
| contexts | `~/.config/colinear/contexts/<name>.json` |
| custom views | `~/.config/colinear/views/*.json` |
| task / planner / UI state | `~/.local/state/colinear/state.json` (pruned by `retentionDays`) |
| debug log + diverted stderr | `~/.local/state/colinear/colinear.log` |
| daemon socket + pidfile | `~/.local/state/colinear/coli.sock`, `coli.pid` |
| worktrees | `<repo>-worktrees/<ISSUE-KEY>`, review checkouts `review-<n>` |
| session transcripts | `~/.claude/projects/<encoded-worktree>/<session>.jsonl` (Claude Code's own) |

A non-default context moves all the state paths under `~/.local/state/colinear/contexts/<name>/`; `COLINEAR_STATE_DIR` overrides them outright.
