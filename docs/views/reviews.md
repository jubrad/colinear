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

`enter` opens the **review document** full screen — the agent's write-up on one side, a discussion
with that same agent on the other (`tab` switches, `j/k` scrolls, `e` edits it in `$EDITOR`). Your
turn resumes the reviewing session, so the PR is still in context; when the agent needs a decision it
asks in the same pane.

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
| `r` start a pre-review · `x` cancel one · `u` refresh the list |
| `enter` | the review document + discussion |
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
