# `:reviews` — PRs awaiting your review

Aliases: `rev`, `pr`. PRs where your review is requested, across every repo your `gh` auth can see,
refreshed every five minutes.

![The review queue: two PRs, the selected one pre-reviewed with four findings graded lead, blocking, consider and nit](../images/reviews.png)

## What wants you

Two facts decide whether a row needs you, and neither is the review's status:

| | |
|---|---|
| **`●`** | **you** were asked, by name |
| **`○`** | a **team you are on** was asked — anyone on it can take it |
| **`↻`** | the author has **pushed since you reviewed** — what you said may no longer apply |

GitHub's `review-requested:<you>` search returns both kinds, and the PR lists its requested
reviewers: if you are there by name it was asked of you, and if you are not — yet the PR came back
from a search for *your* requests — it reached you through a team. Naming the team would need an org
scope colinear doesn't ask for, and the distinction doesn't. A team request sorts below work
addressed to you, because it may already be someone else's.

`●`/`○` disappear the moment you post, because submitting a review fulfils the request: the PR
leaves the search while the row stays here. That is the difference between "waiting on you" and "you
have had your say".

`↻` compares the PR's current head against the commit your review was posted about (or, before
posting, the one the document was written against). It outranks `●` — a review that no longer
applies is more urgent than one not yet started — and sorts to the top under `needs me`. Pressing
`r` on it starts [round two](#round-two) rather than a fresh review.

The push is also written to the review's activity, once, on the poll that finds it.

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
┌ diff ──────────────────────────────┬──────────────────────────┐
│     1  fn reconnect(&mut self) {   │                          │
│ ▍  42 +    for _ in 0..RETRIES {   │ ▌ This retry loop has no │
│     43        self.call()?;        │ ▌ backoff, so a flapping…│
│ ▍  44 +    self.handle = sub()?;   │ │ Re-opens the SUBSCRIBE │
├────────────────────────────────────┴──────────────────────────┤
│ you  why does the casing matter?                              │
└───────────────────────────────────────────────────────────────┘
```

The right column is a **margin**: every comment sits at the height of the line it is about, so you
read the two together without looking anything up. A review document read end to end gives you the
findings in the agent's order; this gives them in the **code's** order, which is the order you check
them in. `▍` marks an annotated line, `n`/`N` walk between them, and the view opens on the first one
rather than on a file header.

Two kinds share the margin, told apart by their bar:

- **`▌` a comment** the agent would send, coloured by severity — red *blocking*, yellow *consider*,
  grey *nit*, green *praise*;
- **`│` an annotation** in **blue** — severity **`info`**, which is *never posted*. It explains what
  a dense block is doing so whoever reads the review can follow the change without reconstructing
  it. Blue is deliberately off the red → yellow → green ramp: an explanation is not a mild problem,
  and any colour on that ramp reads as one.

They live in one list, so an annotation is editable exactly like a comment — and promoting one to a
real severity is how "I had to explain this to myself" becomes "the author should know this". An
`info` finding is filtered out of the inline comments, out of the body, and out of the severity
counts; a review holding nothing but annotations has nothing to post, and says so.

Long code lines **wrap** rather than being cut — the end of a line is where a call's arguments and a
condition's tail live. A wrapped line keeps its line number on the first row only, and the margin
follows: a line that takes three rows pushes the next annotation down by three, so the two stay
aligned.

Each block opens with **what it is** — `blocking ·`, `nit ·`, `note ·` — in the severity's colour,
so two findings on adjacent lines read as two findings rather than one run-on. Continuation rows are
dimmed, which is the other half of the same signal.

Alignment wins over completeness in the margin itself: a comment block starts at its anchor's row
and never shifts, so one that would run into the next is cut with an `…` rather than pushing the
code out of line. **`enter` reads the cut one in full** in the right pane, and any key returns. A comment about the PR as a whole has no line to sit beside,
so it gets its own line under both panes.

The chat along the bottom is one line, so **enter sends it**.

**The right pane is editable**, because the agent's comment is a draft of yours.

`e` on any line — whether or not something is already there — asks **what kind** first:

```
▸ blocking   would request changes over it
  consider   worth a second look
  nit        optional polish
  praise     worth saying out loud
  annotation explains the code — never posted
```

`j`/`k` or the kind's first letter, `enter` to write it. Editing something that already exists
pre-selects what it is, so changing your mind about severity is the same keystroke as changing the
words. Then the editor names the kind *and* what happens to it — "goes to the author when you post",
or "stays in colinear — never posted" — because that is the difference that matters.

`ctrl+d` saves, an empty comment removes it, and `d` drops one outright. **`i` skips the picker** and
goes straight to an annotation, which is the common case while reading unfamiliar code. Every edit rewrites the ```findings fence in the review document,
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
