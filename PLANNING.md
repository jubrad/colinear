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

## Decisions (agreed in review, 2026-08-19)

1. **The tracker is the source of truth for the design.** Priority: a Linear project
   *document* (capability `documents`; sqlite grows a documents table), falling back to the
   project description/content where a provider has no documents. Notion noted as future, out
   of scope. The local file is a **draft workspace only** — publishing is an explicit,
   operator-gated action, and reopening `:plan` always pulls fresh from the tracker.
2. **The ```plan fence never appears in the published doc.** Machine JSON doesn't belong in a
   document teammates read; the issues and milestones *are* the structured store. The fence
   exists only in the draft, between "agent proposed" and "operator approved", then dissolves
   into tracker objects. Publish strips it.
3. **`D` dispatches wave-by-wave**: create everything, dispatch only unblocked/first-milestone
   issues; the blocked-recheck sweep pulls later waves.
4. **Approval is reconciliation, not creation**: create what's missing (matched by title
   against the project's issues), skip what exists and say so, and list what's no longer in
   the plan without cancelling it — cancellation is a per-item operator keypress (v1 reports
   only; propose-cancel joins phase 4 with the coordinator).
5. **Change lifecycle**:
   - Outside edit (sweep detects `updatedAt` moved): activity line + toast on the project;
     never a silent rewrite of running agents' instructions; never auto-reconciliation.
   - Future sessions get the new brief free (prompts rebuild per session); live sessions are
     nudged via the project channel or `M`, never mid-flight.
   - Work-discovers-design-is-wrong flows backwards through `:plan` → publish.
6. **Channel notices** (coordination experiment on): publishing posts to the project channel;
   outside edits post after a one-sweep quiet debounce (Linear saves continuously mid-edit).
   Deterministic text, no session. Sender identity `colinear`, distinct from operator posts.
   No auto-wake — agents read the channel at their pre-PR checkpoint; urgent redirects stay
   `M`. With coordination off, activity + toast only.
7. **Provenance**: issues created from a plan carry a footer link to the doc + revision date.

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
- Store: a `ProjectPlan` record keyed by project id, CDC'd like reviews (`plan-*` deltas):
  `{ draft, docId, docUpdatedAt, publishedAt, summary, milestones, issues, status:
  drafting|ready|published, sessionId }`. The record mirrors the tracker doc (docId/updatedAt
  for change detection + publish-conflict refusal) and holds the draft; the tracker copy is
  authoritative. Sub-issue prompts read the mirrored brief from here (family-context block).
- Commands: `startPlan {projectId}`, `planChat {projectId, text}`, `reloadPlanDoc {projectId}`,
  `approvePlan {projectId, drop: string[], dispatch: boolean}`.
- Approval reconciles (decision 4): milestones first (capability-gated), then missing issues
  (project-assigned, `blockIssue` deps, milestone attached, provenance footer), skip-existing
  reported, obsolete listed; wave-1 dispatch if `dispatch`.
- Publish: strip fence, `documentUpdate`/`documentCreate` (fallback: project content), refuse
  when tracker `updatedAt` moved since the draft was cut — re-pull, re-apply, retry.
- Phase 1 includes the `documents` capability (Linear Document API + sqlite table) since
  publish needs it; milestones stay phase 2.
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

### Phase 1.5 — change detection + channel notices

- Sweep compares mirrored `docUpdatedAt` per planned project; on movement: activity + toast,
  and (coordination on) a debounced deterministic notice to the project channel as identity
  `colinear`. No auto-wake, no sessions for notices.

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

- [x] Phase 1 — shipped (branch `project-plans`): store entity, PlanManager, documents capability, :plan view
- [x] Phase 1.5 — shipped (branch `plan-change-notices`, stacked on phase 1): docSeenAt + sweepDocChanges, debounced `colinear` channel notices
- [ ] Phase 2
- [ ] Phase 3
- [ ] Phase 4
