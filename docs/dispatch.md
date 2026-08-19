# How dispatch works

Dispatching (`enter`, or `c` for the custom modal) immediately self-assigns the issue and moves it to In Progress. Issues with unresolved **blocking relations** park as ⛓ blocked in the Queued column and start automatically when their blockers complete — rechecked every minute and whenever a colinear task finishes; `f` force-starts one, converting its blockers into merge-order dependencies that hold the PR in draft instead. Then per issue:

1. **Worktree** off `<remote>/<defaultBranch>` under the repo's `worktreeRoot`. If the task has a pinned or open PR, the worktree checks out **that PR's branch** instead, and an existing worktree already holding the branch is reused.
2. **Triage pass** (read-only): picks the **repo** the work belongs in (from the allowlist descriptions), a JSON verdict `do` / `too_big` / `needs_info`, and a **verification tier** — `local-light` (lints + unit tests), `ci` (agent confirms the CI config covers the change, then pushes the draft PR early and lets GitHub carry the heavy suites), or `needs-env` (contended local envs: verify what's possible, list the rest in the PR body). `too_big` / `needs_info` land in **Needs Input** for you to decide. For `too_big` the agent also returns a **split plan** — single-repo sub-issues with dependencies; entering the task lands in plan review: `space` to drop items, `A` to create them as sub-issues (with `blocks` relations), `D` to create **and** dispatch (later, `u` on the parent card dispatches its sub-issues via a picker). `c` posts the breakdown to the tracker as a comment instead; `r` requeues once you've acted. `D` at dispatch time (or the modal's triage field) skips triage entirely; re-dispatch keeps a successful triage plan unless you ask for a redo.
3. **Work pass**: every session opens with a full task-context block (issue + description, parent, repo/remotes, all PRs with pin markers, triage plan, your instructions, merge-order dependencies). Existing PRs are **adopted** — the agent reviews their diff and pushes to their branch, never duplicates. A subtask checklist file drives the card's progress bar; lints and tests per the verification tier; subagent diff review; push to the repo's `pushRemote` (your fork, if configured); draft PR against `prBase` of the upstream via `gh pr create --draft`. Agents may stack PRs (chained by base branch, rendered as a stack). **Agents never mark PRs ready** — that's your `d`.
4. **Checks** from the repo config, then PR polling: state, CI rollup, review decision, mergeability. Matching prefers open/merged PRs over closed duplicates, and `m` can pin the canonical PR (number, `#123`, or URL); a failed task that gains a live PR un-fails itself. With `ciAutofix`, red checks dispatch a fix session that pulls the failing logs and pushes a fix.

## Label dispatch

```json
"autoDispatchLabels": { "CLOUD": "agent", "SAS": ["colinear", "bot"] }
```

A tracker label becomes the dispatch button, **per team**: the minute sweep picks up open issues in
a listed team carrying that team's label and enqueues them through the normal pipeline — triage
included, which is the safety net for anything labelled optimistically.

The map is the scope. A team with no entry is opted out entirely, and each team names its own label
because labels aren't namespaced — `agent` meaning "dispatch this" in CLOUD says nothing about what
it means in SAS, and one team's label on another team's issue does nothing.

The guards are the same purity rule the sub-issue sweep uses. Tracker state decides eligibility
(backlog / unstarted / triage only), so an issue whose finished task was dropped by retention can
never be resurrected by its label. An issue assigned to someone else is never taken — auto-dispatch
self-assigns, and that would be theft. Three per sweep across all teams, so bulk-labelling lands as
a trickle.

Removing the label stops future dispatch and cancels nothing already running.

## Manual dispatch — a worktree, no agent

The custom modal's **start** field has a second setting: `manual — worktree only`. The issue is
assigned and moved to In Progress and the worktree is cut off `<remote>/<defaultBranch>` exactly as
usual, and then nothing runs. The card sits in **Working** with `⏸ worktree ready — r starts it`, no
spinner, no session, no tokens.

This is for the work that goes badly when an agent starts from a blank checkout: a design doc whose
headings are the contract, a file layout you want followed, a first commit that fixes the shape of
the thing. Write it in the worktree (`s` opens a shell there), then `r` hands the same worktree to
an agent — `ensureWorktree` reuses what's there, so the agent starts from your skeleton rather than
inventing its own.

`x` cancels a prepared task the way it cancels a queued one; the worktree stays for `:gc`.

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

Messages land in the activity log either way, so the transcript shows what you told it and when. Waking doesn't touch the tracker — it queues the task the same way `r` does, so no state moves and nothing is posted.

If a session dies between accepting a message and acting on it (an abort, a crash), the message goes back on the task rather than vanishing. That can occasionally repeat one the agent had already read: a duplicate paragraph is a cheaper mistake than a silently dropped instruction.

## Sessions: attach, chat, background

`s` on any task hands your terminal to `claude --resume` in its worktree (a live agent is suspended first — never two writers in one worktree). Chat, steer, do work. Quit claude (`/exit`) and colinear asks **"resume agent in the background? [Y/n]"** — enter sends the conversation, including your interactive stint, back to a headless agent and returns you to the board. `S` opens a plain shell in the worktree without touching the agent.

Restart and in-flight tasks return as `interrupted` (`r` resumes the same transcript); planner chats resume their sessions too. Sessions are cwd-keyed by Claude Code, but colinear pins every session to its worktree path, so you can run `coli` from anywhere.
