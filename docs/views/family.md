# `:family` — split work, together

Aliases: `fam`, `subs`. Argument: a parent's identifier (`:family CLO-67`); without one, every
family on the board.

A tracking parent's sub-issues are ordinary tasks, so the board scatters them across its columns
with nothing to say they belong together, and the parent's card has room for a progress bar and
three titles. This is the whole family on one screen: the parent, then each sub-issue with the
state that matters — status, PR and its state, CI, tokens.

A sub-issue that was **never dispatched** still gets a row, marked as such. *Which of these has
nobody on it* is most of the question this view exists to answer.

| key | what |
|---|---|
| `j/k` `↑↓` · `g/G` | move |
| `enter` | open that task |
| everything else | the board's keys, on the row you're on — `r` resume, `x` cancel, `M` message, `s` attach, `d` promote… |

The actions are the board's, key for key, because a family is a way of *looking* at tasks rather
than a different kind of thing. A row with no task yet has nothing to act on.

`F` on any task — the parent, or any child that knows its parent — opens this view scoped to that
family. (`f` is force-start; `F` is family.)

Colinear has always assembled this picture: it is what a [coordinator session](../../COORDINATION.md)
is handed when it asks `family_status`. This view is the same picture, for the operator.
