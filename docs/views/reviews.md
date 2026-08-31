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

## Adding a pull request yourself

The list is filled by one search — pull requests asking for **your** review — which by construction
never contains your own: you cannot request a review from yourself. That is the right default, since
the list is a queue of what other people are waiting on.

When you do want to read your own work with the same tools, name it:

```
:reviews jubrad/colinear#104
:reviews https://github.com/jubrad/colinear/pull/104
```

Anything that names a pull request works — `owner/repo#123`, `owner/repo/pull/123`, or the URL you
copied out of the browser. An unknown one is fetched and joins the list; a known one is just
selected, as before. Adopted rows carry a `+` in the flag column and **stay** until the PR merges or
closes: they were never in the search, so its silence about them means nothing, and the reconcile
that stales a request nobody is waiting on leaves them alone.

Everything else is the same — `r` pre-reviews it, `enter` reads it against the diff, findings and
annotations behave identically. The one difference is at the end: **GitHub will not let you approve
or request changes on your own pull request**, so `A` and `X` say so rather than posting into a 422.
`p` still posts the comments, which is the part worth having on your own PR.

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
- **`│` an annotation** in **blue** — severity **`info`**, which is *never posted*. Its job is to
  make **your** review possible: the context that lets you judge the code rather than a paraphrase
  of it. The agent is asked for the intent behind a hunk, the invariant it rests on and where that
  is established, what the change really changes when the diff misleads, and what you should check
  to satisfy yourself — and asked *not* to narrate lines that read fine on their own. Blue is
  deliberately off the red → yellow → green ramp: context is not a mild problem, and any colour on
  that ramp reads as one.

They live in one list, so an annotation is editable exactly like a comment — and promoting one to a
real severity is how "I had to explain this to myself" becomes "the author should know this". An
`info` finding is filtered out of the inline comments, out of the body, and out of the severity
counts; a review holding nothing but annotations has nothing to post, and says so. That filtering
happens where the body is rendered rather than at each call site, so no posting path — including
the fallback taken when GitHub rejects a review's inline comments — can leak one.

Long code lines **wrap** rather than being cut — the end of a line is where a call's arguments and a
condition's tail live. A wrapped line keeps its line number on the first row only, and the margin
follows: a line that takes three rows pushes the next annotation down by three, so the two stay
aligned.

**Tabs are drawn as four spaces.** A tab is one character to the layout and up to eight columns to
the terminal, and on a tab-indented source (Go, Make) that gap wrapped rows at the wrong column,
cut the deepest-nested lines shortest, and pushed the code over the annotation pane's border. Four
rather than eight keeps a nested Go function inside a pane it shares with the margin.

Each block opens with **what it is** — `blocking ·`, `nit ·`, `note ·` — in the severity's colour,
so two findings on adjacent lines read as two findings rather than one run-on. Continuation rows are
dimmed, which is the other half of the same signal.

A block starts on its line's row, or **just after the block above it finishes** — whichever is
later. Two findings a line apart cannot both start opposite their own line and both be readable, and
cutting the first one off mid-sentence is the worst of the three ways out, so a crowded block is
pushed down instead of truncated. When a block has moved off its own line it says which line it
belongs to (`↑40`, or `↓40` if it moved the other way), because that is exactly when you can no
longer read it off the row opposite.

**The block you are standing in is the exception to all of it.** It is the one you are reading, so
it is exempt from the cap that keeps a runaway finding from hiding the rest, and it may climb *up*
the pane to find the rows it needs rather than hanging off its own line and running out of them. A
long annotation anchored three rows from the bottom used to show three lines and an ellipsis; now it
takes the pane. Move off it and everything returns to where it was.

Nothing is cut against the next finding; a block is only ever shortened by the bottom of the pane.
When even that is not enough, **`enter` reads the current one in full** in the right pane — `j`/`k`,
`g`/`G` and page keys scroll it, it says where you are (`16/25`), `e` edits what you are reading,
and anything else returns. A comment about the PR as a whole has no line to sit beside, so it gets
its own line under both panes.

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

### Commenting on a block

A comment is often about a *passage*, not a line: the loop rather than its first statement. **`v`
marks a block** — press it, move, and the range grows with the cursor; `▏` runs down the gutter
beside every line in it and the header says what is marked (`▏41–43 selected`). `v` again or `esc`
drops it, and `esc` drops the selection before it closes the view.

With a block marked, `e` writes one finding across the whole range and `d` removes it whole. It is
stored — and posted — the way GitHub stores a multi-line comment: anchored to the **last** line,
with the first recorded as its start. That is why the picker and the editor name the range rather
than the cursor; mark upward from 43 to 41 and the finding is still on 43.

In the margin the block is marked on every line it covers, so its extent is visible in the diff,
while the text hangs off the anchor row alone rather than being drawn once per line.

### Asking what a passage does

**`a` hands the marked lines to an agent and asks it to explain them**, as an `info` annotation on
that range — the same annotation a review writes unprompted, asked for on demand while you are
reading. It is a short, focused session rather than a whole review: it reads those lines and enough
around them to answer properly, appends one finding to the review document, and changes nothing
else.

The row you asked about holds itself open with a spinner (`⠋ explaining these lines…`) until the
answer lands, which it does in place, in the margin, beside the code — the view follows the document
rather than waiting for you to reopen it. A session that dies writes nothing, so after five minutes
the row says **`no explanation came back — see :logs`** instead of spinning for the rest of the day.

`a` with nothing marked asks about the line under the cursor.

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

### When the anchors have gone stale

GitHub rejects a review **entirely** if any one comment names a line that is not part of the diff,
and the ordinary way to get there is the author pushing after the review was written. Colinear used
to fall back to putting every finding in the body — which posted a shape nobody chose, and once put
annotations onto a real pull request.

Now nothing is posted. The rejection is recognised as what it is, any pending review is cleared, and
the review goes back to the agent that wrote the anchors: the checkout is fetched forward to the
PR's current head, and the agent is handed the commits that landed and the exact findings that were
rejected, to re-anchor them against the diff as it is now. A finding whose code has left the diff
can move to a line the diff does touch, or lose its anchor and ride in the body instead.

You get a note in the chat, and `p` posts again once you have read what changed. Nothing reaches
GitHub on that path — not the review, not a comment. Every other kind of failure (auth, a closed PR,
the network) still just fails and says so, because re-anchoring cannot help with any of them.

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
