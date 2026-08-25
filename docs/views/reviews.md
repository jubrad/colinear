# `:reviews` — PRs awaiting your review

Aliases: `rev`, `pr`. PRs where your review is requested, across every repo your `gh` auth can see,
refreshed every five minutes.

![The review queue: two PRs, the selected one pre-reviewed with four findings graded lead, blocking, consider and nit](../images/reviews.png)

## Assisted pre-review

`r` checks the PR out in a worktree and runs one agent over the diff in context. Progress streams
onto the card. **Nothing is posted.**

The detail pane shows the review's worktree and its **session id** as a ready-to-paste
`claude --resume` — the same handles a task shows, and the way back into a review session from
outside colinear.

## Reading it against the code

`enter` opens the **annotated diff**: the PR's diff on the left, and beside each line what the agent
had to say about it. Chat sits along the bottom.

```
┌ diff ──────────────────────────────┬ annotation ─────────────┐
│     1  fn reconnect(&mut self) {   │ blocking · src/a.rs:42  │
│ ▍  42 +    for _ in 0..RETRIES {   │                         │
│     43        self.call()?;        │ This retry loop has no  │
│                                    │ backoff…                │
├────────────────────────────────────┴─────────────────────────┤
│ you  why does the casing matter?                             │
└──────────────────────────────────────────────────────────────┘
```

A review document read end to end gives you the findings in the agent's order; this gives them in
the **code's** order, which is the order you check them in. `▍` marks a line with something on it,
and `n`/`N` walk between them — the view opens on the first one rather than on a file header.

The right pane holds one of two things:

- a **comment** the agent would send (severity-coloured, anchored to the line), or
- a **note** — what this hunk *does*, written for someone reading the code cold. Notes are context
  and are never posted; anything the agent would say to the author is a comment.

**The right pane is editable**, because the agent's comment is a draft of yours. `e` opens it,
`ctrl+d` saves, an empty comment removes it, and `d` drops one outright. `e` on a line with nothing
on it writes a new comment there. Every edit rewrites the ```findings fence in the review document,
so what you post and what the agent sees never diverge — a later chat turn reads your wording, and
`p` posts it.

`d` from the list opens the **document** itself instead — the agent's prose write-up with the same
chat beside it (`tab` switches, `j/k` scrolls, `e` edits it in `$EDITOR`). Your turn resumes the
reviewing session, so the PR is still in context; when the agent needs a decision it asks in the
same pane.

## Round two

Press `r` again on a review you have already posted and it does something different: instead of
reviewing the PR from scratch, it **revises the review you sent**. The worktree is reset to the new
head, the reviewing session is *resumed* — so it remembers what it said and why — and it is handed
two things it could not otherwise know:

- **what landed since**, as the commits after the exact SHA the author received feedback on
  (recorded when you posted), so the diff it reads is the response to your comments rather than the
  whole PR again;
- **the conversation**, inline comments and general discussion, fetched with `gh api` rather than
  by asking an agent to go and look — replies to your own comments are marked as such.

It then goes through the existing findings and decides which are **fixed**, which were **answered**
(the author explained, and was right), which **still stand**, and what is **new** — dropping the
first two rather than keeping them alive to look thorough, and engaging with the pushback on the
third rather than restating the original comment. The document is rewritten whole each round, so
what you see is what round two would post.

`p` then posts the revised review as a second one on the PR.

## Posting

`p` posts, `A` approves, `X` requests changes — the same review with a different event. Posting is
**deterministic, not agentic**: the findings are already structured, so colinear clears any leftover
pending review of yours and makes the `gh api` call itself. It costs no tokens and either works or
says why.

What actually gets sent is deliberately small:

- **inline comments** — one per finding with a file and a line
- **the body** — the lead finding (no file, no line, one sentence), a count by severity
  (`1 must fix / 3 considerations / 1 nit`), an `## Other` section for findings with no line, and
  your note
- `prSignoff` appends attribution to all of that, or to the body alone

The document's prose is written for you, to decide what to send. It never leaves your machine.

## Keys

| key | what |
|---|---|
| `r` | pre-review · **re-review** once posted · `x` cancel one · `u` refresh the list |
| `enter` | the annotated diff · `d` the review document |
| `p` post · `A` approve · `X` request changes · `n` attach a note that rides along |
| `s` | hand the terminal to that review's claude session |
| `S` | sort: needs-me / updated / size / repo / author / cost (again reverses) |
| `o` | open the PR |

A posted review stays on the list while its PR is open — submitting a review *fulfils* the review
request on GitHub's side, so the list can't rely on the request alone, and checks the PR itself
before letting go. When the PR merges or closes, the review settles to stale and its worktree is
reclaimed — not when it's posted, since the author may push again. `/stale` shows the settled ones.

Reviews staled by the old behaviour recover on their own: once per daemon start, stale reviews whose
PR is still open and carries a review of yours get their status back from GitHub's record.
