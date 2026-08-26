# `:diff` — read your own agent's work

Alias: `selfreview`. Argument: a task identifier (`:diff CLO-203`), or `v` on a task whose draft PR
is open.

The [annotated diff](reviews.md#reading-it-against-the-code) pointed at a task's own branch. Same
two panes, same margin, same `.colinear-review.md` behind it — a finding written here is a finding
in every sense. What differs is where it goes: **`p` hands the list to the agent that wrote the
code** instead of posting it to an author.

| key | what |
|---|---|
| `R` | have a **fresh** agent review the branch and write the findings |
| `v` | mark a block, so a comment covers the passage rather than a line |
| `e` `i` | write a comment · write an annotation — the same picker as a PR review |
| `a` | ask an agent what the marked lines do — the answer lands as an annotation |
| `enter` `n`/`N` | read the current finding in full · walk between them |
| `p` | hand the comments back to the agent |
| `tab` | say something to the agent directly |

## Only once the draft PR is open

Colinear opens PRs as drafts and leaves promoting them to you, which is the moment this view is
for: the work is committed, the agent is idle, and the diff you are reading is the diff that
exists. Before that the branch is still moving — half of what you read would be gone by the time
you commented on it — so `v` says so and does nothing.

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
