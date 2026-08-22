# `:plan` — the project plan

Alias: `chat`. Argument: the project name (`:plan Cloud Migration`), or `p` on a project in
[`:projects`](projects.md).

A project's **design document**, shaped in a conversation — on the review-document pattern, with
the storage inverted: **the tracker owns the design** (a project document named `Design`, falling
back to the project description), and what you see here is the working draft.

Opening the view pulls the tracker's copy fresh and starts **nothing**: planning is collaborative,
and the first move is yours. There are two ways to make it.

**`c` — chat about it.** colinear cuts a worktree off the default branch, mints a session id, and
hands your terminal to a real `claude` running in it, already primed with the project, its issues
and the published design. You are in a normal interactive session: think out loud, read the code,
argue with it. Quit (`/exit`) and you land back here. This is the one to reach for when you want to
work the problem out rather than describe it.

**The chat box — submit a plan.** Type a brief, `ctrl+d` sends, and the agent takes it from there;
`d` has the agent open instead, framing the project and asking you the questions that matter. Turn
at a time, without leaving the board.

Both are the *same conversation* — one session id — so you can start interactively and follow up
from the box, or the reverse. While you converge, the agent keeps a short notes section current in
the draft; when the direction is agreed — or you say "write it up" — it replaces the draft with the
full design: prose for humans, ending in a ```plan fence proposing milestones and issues.

The fence is scaffolding, not content: it never publishes. The issues and milestones it proposes
*become tracker objects* when you approve them; the prose becomes the tracker's document when you
publish. Two separate keys, because they are two separate decisions.

## Keys

| key | what |
|---|---|
| `tab` | switch between the draft and the chat input |
| `c` | **chat about it** — a worktree and a live `claude` session, entered directly |
| `ctrl+d` | send a chat turn — the first one starts the session |
| `d` | the agent opens the discussion (doc focus) |
| `j/k` `g/G` | scroll the draft (doc focus) |
| `e` | edit the draft in `$EDITOR` (the `editor` config applies); re-absorbed on return |
| `U` | **publish** — the prose (fence stripped) becomes the project's `Design` document |
| `p` | **post a project update** — the plan's summary, as a tracker status post |
| `A` | **approve** — the fence's issues, reviewed in a list: `space` drops one, `A` creates |
| `D` | approve and **dispatch wave 1** — only issues with no in-plan blockers; later waves start as their blockers land |
| `s` | reopen the plan: re-pull the tracker doc, reset the discussion |

## Approval is reconciliation

Approving never duplicates and never destroys: issues that already exist in the project (matched by
title) are skipped and named; issues in the project that the plan no longer mentions are **listed,
not cancelled** — cancelling is your call, per issue. Created issues carry a provenance footer
pointing at the design revision they came from, and `blockedBy` titles become real blocking
relations.

Milestones reconcile the same way, first: where the provider has them, the fence's milestones are
created if missing (matched by name, existing ones reused, none ever deleted) and each issue is
filed under the milestone it names. An issue naming a milestone that exists nowhere is created
without one, with a warning in the plan's activity. Where the provider has no milestones the
fence's are ignored — also said out loud, not silently.

## When the design changes outside colinear

Planned projects are swept on the poll cadence (about five minutes): when the tracker's document
moves past the revision you last saw — a teammate edited it in Linear — the plan gets an activity
line and you get a toast. The change must survive one quiet sweep before it counts, because Linear
saves continuously while someone types. Noticing never disarms the publish guard: the plan still
refuses to publish over the edit until you reopen (`s`) and pull it.

With the [coordination experiment](chan.md) on, the same detection posts a deterministic notice to
the project's channel as **`colinear`** — publishing does too — so agents on the project's issues
see "the design changed, re-read it before opening a PR" at their next channel read. No agent is
woken or interrupted: live sessions finish on the brief they started with, and future sessions get
the new design for free.

The experiment also gives the plan session coordinator hands: the same `family_*` tools a tracking
parent's coordinator gets (see [COORDINATION.md](../../COORDINATION.md)), scoped to the project's
dispatched issues — live board status, messaging an issue's agent, cancelling one — plus membership
in the project channel as `plan`. It still cannot create tracker objects: proposing means revising
the draft's fence, and `A` stays the gate.

## Publishing is guarded

If the tracker's document changed since your draft was cut — a teammate edited it in Linear —
publish refuses rather than overwriting them blind. Reopen the plan (`s`) to pull their version,
re-apply your changes, and publish again.

## Project updates

`p` posts the plan's summary (plus the milestone/issue counts and the design revision) as a
project update — Linear's status-post stream. Like review posting, the text is **deterministic**,
composed from the mirrored plan record, never from a session: what reaches the tracker is never an
agent's claim about itself.

The worktree `c` cuts lives at `<repo>-worktrees/plan-<project>` on a `plan/<project>` branch.
Nothing pushes it — it exists so the session can read the code — and [`:gc`](gc.md) leaves it alone
while the plan exists, offering it once the plan is removed.

Needs a provider with the `documents` capability for publishing and `projectUpdates` for `p`;
approval works everywhere projects do, and milestones need the `milestones` capability. Demo mode
writes a canned draft and runs no agent.
