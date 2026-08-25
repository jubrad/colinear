# Annotated diff view for reviews — working plan

Delete when it ships; durable content moves to DESIGN.md + docs/views/reviews.md.

Operator brief (2026-08-26): "Linear has a new model where it can show a diff view similar to
github but with AI annotations of what each piece of code does and potential issues… part of
colinear is to create a more collaborative workspace for LLMs and people, I do think seeing the AI
annotations next to the code diff is super useful. Two panes, left shows diff, right shows review
annotation or potential review comment that is editable. Chat gets moved to the bottom."

## Shape

```
┌ diff ─────────────────────────┬ annotation ──────────┐
│ src/a.rs                      │ blocking · a.rs:42   │
│  41   let mut n = 0;          │ This retry loop has  │
│ +42   for _ in 0..RETRIES {   │ no backoff…          │
│  43       call()?;            │ [e] edit  [d] drop   │
├───────────────────────────────┴──────────────────────┤
│ chat: …                                              │
└──────────────────────────────────────────────────────┘
```

## Decisions

1. **The document stays the artifact.** Editing an annotation rewrites the ```findings fence in
   `.colinear-review.md`, so the agent, the operator and `p` all read one source. No second store
   of comments.
2. **Anchor on the new-side line number**, because that is what GitHub's inline comments take and
   what the posting path already sends.
3. **Two kinds of right-pane content**: a *finding* (a potential review comment — editable) and a
   *note* (what this hunk does — read-only, the agent's explanation). Notes are new: an optional
   `notes` array in the fence, so every existing document still parses.
4. **The diff is fetched, not stored**: `git diff base...HEAD` in the review worktree on demand.
   It is large, changes with every push, and belongs to the worktree rather than the record.
5. Editing writes through the daemon, never from the view — same rule as everything else.

## Pieces

- [ ] `core/diff.ts` — parse unified diff → flat lines carrying `file`, `newLine`, `kind`
- [ ] `reviewDiff` command + reply
- [ ] fence writeback: `saveFinding` / `deleteFinding` rewrite the doc, preserving prose
- [ ] `notes` in the fence + the prompt that asks for them
- [ ] `AnnotatedDiff` component: diff pane, annotation pane, chat at the bottom
- [ ] `n`/`N` jump between annotated lines — the reason to use this view at all
- [ ] docs

## Traps

- The fence ends at the first ``` where JSON parses (`extractFencedJson`), never a regex.
- A finding with no `file`/`line` is the lead, or a general point: it has no anchor, so it lives in
  the annotation pane's "unanchored" section rather than being dropped.
- Rewriting the doc must not disturb the prose — splice by the fence's own start/end offsets.
- The doc watcher will see our write; absorbing it again is harmless but must not loop.
