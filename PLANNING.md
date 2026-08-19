# Project plans — implementation plan

The work plan for the project-planning feature, written down so it survives context compaction.
Delete this file when the feature ships (its durable content moves to DESIGN.md + docs/).

## What is being built

Replace the client-side `:plan` chat with a **project plan document**, stealing the PR-review
pattern wholesale: an agent writes a markdown plan for a project, the operator chats it into shape
(or edits it in `$EDITOR`), and a structured fence at the bottom becomes issues and milestones when
— and only when — the operator says so.

Operator brief (2026-08-19): "open an agent in the top level project like we do for parent issues
and discuss the plan from there. We could steal the PR review pattern, where the agent creates a
markdown plan, the user chats with the agent then we start."

## Decisions (made; veto in review)

1. **Doc lives in the state dir**, `~/.local/state/colinear/plans/<project-slug>.md` — plans span
   repos, so no single worktree is honest. The plan session's `cwd` is the primary repo (read-only
   tools, same as today's planner) so the agent can use real component names.
2. **`D` dispatches wave-by-wave**: create everything, dispatch only issues whose `blockedBy` is
   empty / whose milestone is first; the existing blocked-recheck sweep pulls later waves as
   blockers land. All-at-once would make milestones decorative.
3. **The plan doc stays local** until the operator explicitly posts it (phase 3's project update).
   Nothing reaches the tracker on `save`, ever — same rule as review posting.

## The pattern being copied (file:line anchors, main @ 2026-08-19)

- `src/core/reviewer.ts` — REVIEW_FILE watch (`watchDoc`), `absorbDoc`, `parseDoc` (fence ends at
  the first ``` where JSON parses — copy this, do not regex), chat via streaming session, `e` →
  `$EDITOR` → `reloadReviewDoc`.
- `src/core/protocol.ts` — `PROTOCOL_VERSION = 7` today; **phase 1 bumps to 8**. Review commands
  (`startReview`/`reviewChat`/`reloadReviewDoc`) are the wire shapes to mirror as
  `startPlan`/`planChat`/`reloadPlanDoc`/`approvePlan`.
- `src/core/planner.ts` — the client-side planner this replaces (261 lines; `Planner`,
  `plannerFor`, `serializePlanners`). Delete once phase 1 lands; its prompt text is worth keeping.
- `src/views/TaskView.tsx:154` — the split-plan review UI (`P`, `space` drop, `A` create, `D`
  create+dispatch) — reuse for plan approval; `Task.proposals` (`types.ts:235`) shows the shape.
- `src/ui/TextArea.tsx` — the chat input.
- Provider: `createProject` + `CreateProjectInput` exist (PR #51). `create()` takes `parentId`,
  `projectId`; `blockIssue()` exists for dependencies.

## Fence schema (```plan)

```json
{
  "milestones": [{ "name": "Cutover", "targetDate": "2026-09-01", "description": "…" }],
  "issues": [{
    "title": "…", "description": "markdown", "repo": "i2",
    "milestone": "Cutover", "priority": 2, "blockedBy": ["Schema import"]
  }]
}
```

`blockedBy` refers to other issue **titles in the same fence** (resolved to ids after creation).
`repo` is enum-constrained to the config allowlist, like the triage schema (`dispatcher.ts`
`triageSchema`). Unknown milestone name on an issue = validation error surfaced in the doc pane,
not a crash.

## Phases

### Phase 1 — plan document + chat + approve (the core)

Daemon side (`src/core/projectplan.ts`, new):
- `PlanSession` per project: doc path, watcher, streaming chat session (SessionInbox pattern from
  agent.ts; termination gotcha: close the stream when a result arrives with nothing pending —
  DESIGN.md "Sessions and messages").
- Store: new `plans` collection? NO — keep it simpler: a `ProjectPlan` record keyed by project id
  with `{ doc, summary, milestones, issues, status: drafting|ready|approved, sessionId }`, CDC'd
  like reviews (`plan-*` deltas). Mirrors the review entity precedent exactly.
- Commands: `startPlan {projectId}`, `planChat {projectId, text}`, `reloadPlanDoc {projectId}`,
  `approvePlan {projectId, drop: string[], dispatch: boolean}`.
- Approval creates milestones first (capability-gated), then issues (project-assigned,
  `blockIssue` for deps, milestone attached), then dispatches wave 1 if `dispatch`.
- Prompt: adapt planner.ts's prompt + reviewer.ts's doc instructions ("the first entry is the
  lead" analog: prose for the operator, fence for the machine, don't write schedules into prose).

UI:
- `:plan PROJECT` becomes the doc+chat split (reuse the review document view layout in
  ReviewsView/read mode), `e` edits in `$EDITOR` (editor config from PR #60 applies via the
  existing `edit-file` pending-action), `A`/`D` open the approval list (split-plan UI).
- `p` in `:projects` keeps navigating here.

Gates: typecheck, build, CDC replay (new deltas!), demo-mode plan (local draft like
`demoDraft` in newproject.ts — no agent), ttyd walkthrough, docs (`docs/views/plan.md` rewrite).
Daemon restart note: protocol 8.

### Phase 2 — milestones capability

- `ProviderCapabilities.milestones`; Linear `projectMilestoneCreate` + milestone on issue create;
  sqlite table. Milestone chip on `:project` cards. Fence `milestones` ignored (with a doc-pane
  warning) where the capability is false.

### Phase 3 — project updates

- `ProviderCapabilities.projectUpdates`; Linear `projectUpdateCreate`.
- Post-approval: one keypress posts the plan summary as a project update (deterministic, never a
  session — review-posting rule).
- Later: `U` drafts a status update from live board state (merged/in-flight/blocked), operator
  edits, deterministic post.

### Phase 4 — the project agent grows coordinator hands

- When the coordination experiment is on, the plan session gets the coordinator tools
  (message/cancel its project's sub-agents, propose additions gated behind `A`) — see
  `coordinator.ts` + COORDINATION.md. The plan doc becomes the project's living brief.

## Known traps (learned this session, do not relearn)

- Fence parsing: end at the first ``` where JSON parses (`extractFindingsBlock`), never non-greedy
  regex — embedded code fences inside JSON strings truncate it.
- Reconcile/staling: nothing with operator investment gets dropped on absence — plans should never
  be auto-deleted; only the operator removes one.
- Probes: always `COLINEAR_STATE_DIR` isolation; `log()` writes to the real log otherwise.
- dist discipline: the live daemon runs the last build; build only from branches carrying every
  unmerged daemon fix the operator depends on.
- Popup: render last in the tree, explicit height; TextArea owns enter, footer says which key
  sends (ctrl+d) — never two stories about enter.
- Protocol bump ⇒ `coli daemon stop && coli`, not `R`.
- `bin/gen-docs --check` gates docs; new view content needs `docs/views/plan.md` current.

## Status

- [ ] Phase 1 — in progress (branch `project-plans`)
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
