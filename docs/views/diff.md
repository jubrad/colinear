# `:diff` — read your own agent's work

Alias: `selfreview`. Argument: a task identifier (`:diff CLO-203`), or `v` on a task whose draft PR
is open.

The [annotated diff](reviews.md#reading-it-against-the-code) pointed at a task's own branch — the
same in every way: syntax-highlighted, full-screen with a tab per changed file (`]`/`[` to hop, `f`
for the header), one pane for the level and the comment (`tab` between them), same margin, same
`.colinear-review.md` behind it. A finding written here is a finding in every sense. What differs is
where it goes: **`p` hands the list to the agent that wrote the code** instead of posting it to an author.

![The same view against a task's own branch: a `consider` finding beside the line it is about, and a footer whose keys end in R review and p hand back](../images/task-diff.png)

| key | what |
|---|---|
| `R` | have a **fresh** agent review the branch and write the findings |
| `v` | mark a block, so a comment covers the passage rather than a line |
| `]` `[` | hop to the next / previous changed file · `f` full screen |
| `/` `*` `x` | search the checkout · the call sites of a symbol on the line · the whole file around the hunks — see [reading around the change](reviews.md#reading-around-the-change) |
| `e` `i` | write a comment · write an annotation — level and comment in one pane, `tab` between. The `comment` level (`m` on the level row) is an unlabelled question or note — see [reviews](reviews.md#reading-it-against-the-code) |
| `a` | ask an agent what the marked lines do — the answer lands as an annotation |
| `c` | ask about them your own way — a model and a request; a critique that finds a problem comes back as a finding you can hand back with `p`. See [asking with a model and a request](reviews.md#asking-with-a-model-and-a-request) |
| `enter` `n`/`N` | read the current finding in full, scrolling · walk between them, one at a time where a line has several |
| `p` | hand the comments back to the agent |
| `w` | measure against [the whole branch, since your hand-back, or live](#measured-against-what) |
| `tab` | say something to the agent directly |

## While the agent is still writing

`v` works on a task whose agent is at work, not only once its draft PR is open. You get the
worktree **as it stands** — committed, uncommitted and untracked work against where the branch
left its base — re-read every four seconds, so you can watch the change take shape and stop it
early (`x` on the board) if it is heading somewhere wrong.

A file with work **not committed yet** has an amber tab and says so on the strip, and its diff
opens with a line saying the agent is still writing it. The cursor follows its line as the diff
moves: an agent writing above where you are reading renumbers every line below, so the view finds
your line by its text rather than its number.

It is **read-only** until the draft PR opens. `/`, `*`, `x`, `]`/`[` and `n`/`N` all work; the keys
that write a comment, ask about lines or hand back say why they do not. Half of what you commented
on would be gone by the time the agent read it — the same reason colinear waited before, applied to
commenting rather than to reading. Reading the worktree never touches its index: untracked files are
diffed against nothing rather than added with `git add -N`.

## Measured against what

`w` switches what the diff is measured against, and the title says which you are reading:

| | |
|---|---|
| **the whole branch** | everything since it left its base — the PR. The default once the draft PR is open |
| **since you handed it back** | only what the agent committed after your last `p` — its answer to your comments. Offered once you have handed something back; the commit the branch was at is recorded when you do |
| **live** | the worktree as it stands, uncommitted work included. The default while an agent is writing, and offered on an open PR the agent is revising |

After a hand-back, *since* is the diff worth reading: the agent was told to touch nothing that was not
raised, and this shows whether it did.

## The reviewing agent is a different one

`R` starts a **fresh** session rather than asking the agent that wrote the code. An agent reviewing
its own work in its own context agrees with itself; a session that arrives cold, reads the diff and
reads around it is the only one whose "this looks fine" is worth anything. It gets the issue the
work was meant to solve, so it can ask whether the change actually does that.

Its `info` annotations matter more here than on a PR: you are about to read a diff you did not
write, and what a hunk assumes is the thing you cannot see.

## Handing it back

`p` composes the findings into an instruction and gives it to the agent — deterministically, like
posting a review, so what the agent is asked to do is what you read. **Annotations are left out**:
the agent wrote this code and does not need it explained back, which is the same rule as never
posting them to an author, arrived at from the other direction.

The task stays in **PR Open** and blinks as `revise` maintenance. It is not going back into
development — the PR is where it was, and the agent is answering comments on code it already
wrote. It is told to push back where it disagrees rather than make a change it believes is wrong,
and to touch nothing that wasn't raised.
