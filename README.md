# colinear

A k9s-style TUI that runs Claude Code agents against Linear. Browse issues, dispatch agents (one git worktree each, subscription auth), watch a live kanban board, answer agent questions inline, attach to any agent's session and hand it back, plan projects in a chat that drafts subtask issues, pre-review other people's PRs, and track draft PRs / stacks / CI / review state — without leaving the terminal.

- [Install](#install)
- [Configuration](#configuration) · [reference](#config-reference) · [repos](#repos) · [guidance](#guidance) · [contexts](#contexts)
- [Daemon and CLI](#daemon-and-cli)
- [Views](#views) · [PR review](#pr-review)
- [How dispatch works](#how-dispatch-works) · [Sessions](#sessions-attach-chat-background)
- [Custom views](#custom-views) · [Files](#files) · [Notes](#notes)

## Install

```bash
npm install
npm run doctor    # checks claude CLI, gh auth, Linear key, repo
npm link          # installs `coli` + `colinear` on PATH (builds dist)
coli              # or: npm run dev
```

Requirements: `claude` CLI logged in (subscription auth — leave `ANTHROPIC_API_KEY` unset), `gh` authenticated, Linear personal API key. Optional: `brew install terminal-notifier` makes notifications click through to the PR/issue.

## Configuration

`~/.config/colinear/config.json` (legacy `~/.colinear.json` also works); `LINEAR_API_KEY` env var covers the key. View and edit live with `:config` — `e` opens `$EDITOR`, seeds the file from current settings on first use, and changes hot-apply on return. A config file that exists but doesn't parse is a startup error rather than a silent fallback to defaults.

```json
{
  "linearApiKey": "lin_api_...",
  "repos": [
    {
      "name": "cloud",
      "path": "~/work/cloud",
      "description": "Materialize Cloud control plane: controllers, sync-server, Pulumi infra",
      "defaultBranch": "main",
      "worktreeRoot": "~/work/cloud-worktrees",
      "checks": [{ "name": "fmt", "cmd": "bin/fmt --check" }]
    },
    { "name": "materialize", "path": "~/work/materialize", "pushRemote": "jubrad" }
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
| `attachPermissionMode` | `"auto"` | permission mode for `s` attach sessions: `auto` (classifier gates risky commands), `acceptEdits`, `bypassPermissions`, `default`. Headless agents always run `auto`; classifier-blocked commands surface on the board as allow/deny questions |
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

### Experimental features

Features that work but aren't settled — the shape, the token cost or the prompt discipline may still change, and they can affect what agents do. Each needs two switches:

```json
"experimental": true,
"experiments": { "coordination": true }
```

The master switch is separate so one line turns everything experimental off when something misbehaves, without you having to remember which features you'd enabled. Naming a feature without it — or naming something that isn't an experiment — is written to the debug log rather than silently ignored, so a feature never quietly fails to run.

| experiment | what |
|---|---|
| `coordination` | **Family coordination channels, and coordinator sessions for tracking parents.** Sub-issue agents in one family share an IRC-style channel (`#CLO-67`) through in-process MCP tools: `channel_read` (only what's new since that agent last read) and `channel_post` (identity stamped at spawn — an agent can't pose as a sibling or reach another family's channel). They're prompted to claim scopes, announce architectural decisions, flag shared resources they're using, and read before opening a PR. `:chan` lists channels, `:chan CLO-67` tails one with an input box — your message reaches every agent in that family at its next read. A **tracking parent** — an issue whose work happens in its sub-issues — becomes coordinatable: `M` a message to it (or `r`) starts a *coordinator* session that can read the family's live state, relay instructions to a sibling's agent, cancel one, and propose new sub-issues. It writes no code and gets no checkout. It also **cannot create Linear issues**: proposals land on the parent card and wait for your `A`. Full design, storage layout and deferred work: [COORDINATION.md](COORDINATION.md) |

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

## Daemon and CLI

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

## Views

`:` jumps (tab completes), `:reload` refreshes custom views.

| view | what |
|---|---|
| `:issues [team\|all\|mine]` | sortable issue table (priority, parent link for sub-issues, labels, state, assignee); `/` fuzzy, `t` team (k9s-namespace style), `l` label, `s` sort by any column, `p` include/exclude project issues; `space` select, `enter` dispatch, `D` dispatch skipping triage, `c` custom dispatch (instructions + model + repo + triage, in a popup over the list), `n` **new issue from a description** (an agent drafts and files it), `o` open in Linear, `b` board. Queries paginate (500 cap); the default view shows non-project issues only |
| `:board` | kanban: Queued / Triage / Working / Needs Input / PR Open / Done / Failed. `j/l` move columns, `i/k` move cards (arrows too); cards show live duration, tokens, repo, subtask progress, CI + review state. `a`/`1-9` answer, `enter` task detail, `m` **edit task** — a dialog that takes over the view (repo, pinned PR, instructions, model, triage, auto-rebase, auto-dispatch subs), with the focused field explaining itself and `config default` naming its current value; `enter` saves, `ctrl+r` saves and requeues, `u` dispatch sub-issues (picker), `s` attach claude, `S` shell, `x` cancel, `r` resume, `b` rebase a conflicting PR, `f` **force-start a blocked task**, `c` post escalation to Linear, `M` **message the agent** without attaching, `o` open PR, `O` open issue, `n` issues, `/` the same tasks as a searchable table |
| `:tasks` (`ls`, `t`) | the same tasks as a **searchable, sortable table** — for when there are more cards than a column can show. `/` fuzzy filters across id, title, repo, status, PR state and CI (so `/conflict` or `/needs` works), `S` sorts by any column (again on the same one reverses), `j/k` move, `g`/`G` jump. Default order is the board's: column left-to-right, then what needs you first. Every board action works here, key for key (`enter`, `m`, `M`, `s`, `x`, `r`, `f`, `b`, `c`, `o`, `O`, `u`, `a`) — only `S` differs, since it sorts rather than opening a shell. The selected task's detail pane sits below the table when the terminal is tall enough. `/` on the board jumps straight here |
| `:task CLOUD-123` | full detail: scrollable activity log (`j/k`, `g` top, `G` follow), subtasks, dependencies, check output, PR overview (draft/state, CI, review decision, URL, stack base); `d` marks the draft PR ready — the only path out of draft. `d` refuses while a merge-order dependency hasn't landed, naming it; `D` promotes anyway (colinear knows when a blocker **merged**, never whether it **deployed**) |
| `:projects` / `:project NAME` | projects table (state, progress, lead, teams, target; `/` `t` `s` filters + sort) and per-project kanban; `d`/`c` dispatch, `p` planning chat |
| `:plan PROJECT` | persistent chat with a read-only planning agent; proposes subtasks as drafts — `space` toggle, `A` create in Linear, `D` create + dispatch |
| `:reviews` (`pr`) | PRs waiting on **your** review, and the assisted pre-review flow. [Details](#pr-review) |
| `:costs` (`$`) | spend per run — tickets **and** PR reviews — live: a bar chart sorted by cost (`s` cycles cost/tokens/recent), `/` fuzzy filter, `enter` task detail. Bars are colored by task status. Figures are what the work *would* cost on the API — subscription runs are not billed per token |
| `:logs` (`debug`) | the live debug log — everything colinear is doing, including stderr diverted while the TUI owns the screen. `j/k` scroll, `space` page, `g` top, `G` follow, `/` filter |
| `:gc` (`disk`) | worktree disk: what can be reclaimed and how much. `space` picks, `a`/`n` all/none, `+`/`-` change the keep-window (`worktreeRetentionDays`), `x` removes, showing progress per worktree as it goes. Live tasks and reviews still in play are never listed; branches and commits stay in the repo |
| `:chan` (`channel`, `irc`) | **experimental** — coordination channels, one per issue family. `enter` opens one, `:chan CLO-67` tails it with an operator input; `esc` leaves. Empty (and read-only) unless the [`coordination` experiment](#experimental-features) is on |
| `:config` | resolved config (key masked), available contexts, `e` to edit |
| `:help` (`?`) | all views, keys, custom view schema |

Global: `esc` clears filters then goes back, `q` back/quit, `R` reloads the frontend on new code (agents keep running), `ctrl+c` quit. Crumbs + toasts at the bottom; the header shows user, repo (plus context, if any), agents and tokens/cost, alongside the current view's hotkeys. The board opens first when a previous run's tasks were restored.

### Board card sorting

Within a column, cards sort by what wants you first — changes requested and conflicting, then approved, draft, awaiting review — and the header carries a coloured count per state:

```
PR Open(7)  1-1-2-2-1
```

pink changes-requested · red conflicting · green approved · grey draft · orange awaiting review · purple merged · red closed. The two that need a human sort first.

## PR review

`:reviews` lists PRs awaiting **your** review (`gh search prs --review-requested=@me`, across every repo your `gh` auth can see), refreshed every 5 minutes. `R` refreshes on demand, `S` sorts (needs-me / updated / size / repo / author / cost — pressing it again on the same field reverses), `o` opens the PR.

`r` starts an **assisted pre-review**: colinear checks the PR out in a worktree and an agent reads the diff in context, returning an overview plus findings. Progress streams onto the card while it works; `x` cancels.

**The document is the artifact.** `enter` opens it full-screen — the agent's write-up on one side, a **discussion** with that same agent on the other (`tab` switches, `j/k` scroll, `e` edits it in `$EDITOR`). The discussion goes both ways: your turn resumes the reviewing session, so the PR is still in context, and when the agent needs a decision it asks in the same pane — answer inline, or press the option number. `s` hands the terminal to that review's own claude session (suspending the agent first, as on the board). `n` attaches a note of your own that rides along with whatever gets posted.

**Nothing reaches GitHub until you ask.** `p` posts the review, `A` approves, `X` requests changes — the same review, with a different event. Posting is deterministic rather than agentic: the findings are already structured, so colinear clears any leftover pending review of ours (GitHub allows one per user per PR, and a stale one blocks every new review) and makes the `gh api` call itself. It costs no tokens and either works or says why — an agent doing the posting can report success its own tool call didn't have.

What actually gets sent is deliberately small, because the document is written for you and none of it belongs on someone else's PR:

- **inline comments** — one per finding that has a file and a line
- **the body** — the *lead* finding (no file, no line, no severity, one sentence), then a count of what was raised (`1 must fix / 3 considerations / 1 nit`), an `## Other` section for anything with no line to attach to, and your note
- `prSignoff` / `prSignoffScope` append attribution to all of that, or to the body alone

Findings survive missing fields — no `line` or no `file` routes one to the body rather than the bin; only a missing `comment` drops it. Review worktrees are reclaimed once the PR merges or the review goes stale, not when it's posted: the author may push again.

## How dispatch works

Dispatching (`enter`, or `c` for the custom modal) immediately self-assigns the issue and moves it to In Progress. Issues with unresolved Linear **blocking relations** park as ⛓ blocked in the Queued column and start automatically when their blockers complete — rechecked every minute and whenever a colinear task finishes; `f` force-starts one, converting its blockers into merge-order dependencies that hold the PR in draft instead. Then per issue:

1. **Worktree** off `<remote>/<defaultBranch>` under the repo's `worktreeRoot`. If the task has a pinned or open PR, the worktree checks out **that PR's branch** instead, and an existing worktree already holding the branch is reused.
2. **Triage pass** (read-only): picks the **repo** the work belongs in (from the allowlist descriptions), a JSON verdict `do` / `too_big` / `needs_info`, and a **verification tier** — `local-light` (lints + unit tests), `ci` (agent confirms the CI config covers the change, then pushes the draft PR early and lets GitHub carry the heavy suites), or `needs-env` (contended local envs: verify what's possible, list the rest in the PR body). `too_big` / `needs_info` land in **Needs Input** for you to decide. For `too_big` the agent also returns a **split plan** — single-repo sub-issues with dependencies; entering the task lands in plan review: `space` to drop items, `A` to create them as Linear sub-issues (with `blocks` relations), `D` to create **and** dispatch (later, `u` on the parent card dispatches its sub-issues via a picker). `c` posts the breakdown to Linear as a comment instead; `r` requeues once you've acted. `D` at dispatch time (or the modal's triage field) skips triage entirely; re-dispatch keeps a successful triage plan unless you ask for a redo.
3. **Work pass**: every session opens with a full task-context block (issue + description, parent, repo/remotes, all PRs with pin markers, triage plan, your instructions, merge-order dependencies). Existing PRs are **adopted** — the agent reviews their diff and pushes to their branch, never duplicates. A subtask checklist file drives the card's progress bar; lints and tests per the verification tier; subagent diff review; push to the repo's `pushRemote` (your fork, if configured); draft PR against `prBase` of the upstream via `gh pr create --draft`. Agents may stack PRs (chained by base branch, rendered as a stack). **Agents never mark PRs ready** — that's your `d`.
4. **Checks** from the repo config, then PR polling: state, CI rollup, review decision, mergeability. Matching prefers open/merged PRs over closed duplicates, and `m` can pin the canonical PR (number, `#123`, or URL); a failed task that gains a live PR un-fails itself. With `ciAutofix`, red checks dispatch a fix session that pulls the failing logs and pushes a fix.

## Answering an agent's questions

When an agent needs a decision it lands in **Needs Input**. `a` opens the answer form — on the board, in `:tasks`, or in the task view:

```
╔═══════════════════════════════════════════════════════════════════════╗
║  question · CLO-142 — 1 of 2                                          ║
║  [Auth method]                                                        ║
║  The new /v2/sync endpoint needs to authenticate callers. Which       ║
║  mechanism should it use, given the controller already talks to       ║
║  sync-server over mTLS?                                               ║
║                                                                       ║
║  ▸ 1. mTLS                                                            ║
║        reuses the existing trust chain; no new secrets to rotate      ║
║    2. Bearer token                                                    ║
║        simpler to test locally, but needs a rotation story            ║
║    3. your own answer                                                 ║
║  ↑↓/1-2: pick · enter: next question · e: write it in $EDITOR         ║
╚═══════════════════════════════════════════════════════════════════════╝
```

- **Every question, not just the first.** One `AskUserQuestion` can carry up to four; colinear used to show one and drop the rest, so the agent asked the others again on its next turn. The form steps through them (`←` goes back to change an answer) and sends them together.
- **Option descriptions are shown.** The agent explains what each choice means and what it costs — that text used to be discarded, leaving a list of bare labels.
- **`1`–`9`** picks an option outright without opening the form, when there's a single question — the common case shouldn't need a form at all.
- **`e` writes it in `$EDITOR`** as a markdown form: every question, its options, and an `Answer:` heading under each. Save and quit and the answers are sent. This is the one for a paragraph, or for answering four questions in one pass; anything left blank is sent as "you decide".
- **Permission prompts** (an `auto`-mode classifier blocking a command) use the same form, with allow/deny as the options.

The card and detail pane show a preview — the question, its options, and how many are waiting — but answering happens in the form, which has the room for it.

## Talking to a running agent

`M` on a card (board or `:tasks`) sends the agent a message without attaching to it — "use the existing helper", "don't touch the schema", "rebase first".

- **A live agent** takes it at its next turn boundary. It can't interrupt a command already running, so a message sent during a four-minute test run lands when that finishes; usually it's seconds. The session is a streaming conversation, so your message arrives as a user turn — the agent answers it and carries on.
- **An idle task** — PR open, done, failed, interrupted, needs-input — is **woken**: colinear starts a session (resuming the same transcript, so the work is still in context) whose opening prompt carries your message. Sending is the whole gesture; you don't have to remember to press `r` afterwards. `ctrl+q` sends without waking if you'd rather it wait.
- **Parked work stays parked.** A `blocked` task keeps the message but is not started — a message is not a reason to jump a dependency, `f` is — and neither is a `tracking` parent or a task already queued. Their message rides into the session they were going to have anyway.

| task is | your message |
|---|---|
| working / triage / checks / rebasing | pushed into the live session, read at the next turn |
| pr open, done, failed, interrupted, needs input | queued, and a session starts to read it |
| tracking parent (with `coordination` on) | queued, and a **coordinator** session starts to act on it |
| blocked, tracking (experiment off), already queued | queued for the session it was already going to have |

Messages land in the activity log either way, so the transcript shows what you told it and when. Waking doesn't touch Linear — it queues the task the same way `r` does, so no state moves and nothing is posted.

If a session dies between accepting a message and acting on it (an abort, a crash), the message goes back on the task rather than vanishing. That can occasionally repeat one the agent had already read: a duplicate paragraph is a cheaper mistake than a silently dropped instruction.

## Sessions: attach, chat, background

`s` on any task hands your terminal to `claude --resume` in its worktree (a live agent is suspended first — never two writers in one worktree). Chat, steer, do work. Quit claude (`/exit`) and colinear asks **"resume agent in the background? [Y/n]"** — enter sends the conversation, including your interactive stint, back to a headless agent and returns you to the board. `S` opens a plain shell in the worktree without touching the agent.

Restart and in-flight tasks return as `interrupted` (`r` resumes the same transcript); planner chats resume their sessions too. Sessions are cwd-keyed by Claude Code, but colinear pins every session to its worktree path, so you can run `coli` from anywhere.

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

## Files

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

## Notes

- Repos with multiple remotes need a gh default so PR polling and creation work non-interactively: `cd <repo> && gh repo set-default OWNER/REPO` (once per repo).
- ~5+ concurrent sessions can hit subscription rate limits; default concurrency is 3. Rate-limited sessions retry once after 30s.
- Worktrees are left behind for inspection — `coli gc` reclaims them, and removing one by hand orphans its session (resume then starts fresh).
- Weird behavior: check `~/.local/state/colinear/colinear.log` (or `:logs`). React warnings and SDK stderr land there while the TUI owns the screen.
