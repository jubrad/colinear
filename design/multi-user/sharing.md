# Sharing, forks and costs

By default nobody sees anything of yours. You can share a piece of work with named people or with
everyone signed in, read-only or read-write. Anyone who can see it can fork it into their own
account.

## What gets shared

The unit is an **item**: a task, a review, or a plan. Sharing one covers its card, its activity,
every agent session it has had (live and finished), and what its agents wrote: the diff, the review
document, the plan draft. Sharing a single session alone would leave a viewer looking at a
conversation with no idea what it was for.

```ts
interface Share {
  /** 'users' needs at least one login; 'everyone' means every signed-in user */
  audience: 'private' | 'users' | 'everyone';
  users?: string[];               // tailnet logins
  mode: 'read' | 'write';
  sharedAt: number;
}
// on Task, Review and Plan: share?: Share
```

**The owner's daemon is the source of truth.** The grant lives on the item in the owner's store,
and every viewer connection is checked against it there ([gateway.md](gateway.md#protocol)).
Nothing else can grant access.

## The shared list

People need to find what's been shared with them without the gateway asking every daemon. So
each daemon also publishes an **index entry** for every shared item, as a `ColiShare` object in its
own namespace:

```yaml
apiVersion: colinear.dev/v1alpha1
kind: ColiShare
metadata: { name: task-eng-142, namespace: coli-u-alice }
spec:
  owner: alice@example.com
  item: { kind: task, id: "...", title: "ENG-142 Retry uploads", status: working }
  audience: users
  users: [bob@example.com]
  mode: read
```

The gateway watches `ColiShare` across namespaces and answers `/v1/shared` from that, filtered to the
caller. The entry is only an index. Getting the content always goes to the owner's daemon, which
checks its own grant, so a stale or tampered index entry can show a title and nothing more.

Writing them is part of the daemon's RBAC ([operator.md](operator.md#rbac-and-admission)).

In the TUI, a `:shared` view lists what's shared with you, newest first. Entering one opens it the
way your own items open, through `/v1/view/<user>/<item>`.

`:agents` already lists recently finished sessions next to live ones, but drops them soon after.
It keeps them as long as their item is kept, because a session you might want to share or fork is
usually one that finished a while ago.

## What a viewer gets

A viewer connection gets a snapshot with the one item in it, and its changes as they happen.

| | read | write | owner |
|---|---|---|---|
| see the card, activity, diff, review doc, plan | yes | yes | yes |
| read every session's transcript | yes | yes | yes |
| message the agent (`M`), answer its questions | | yes | yes |
| chat in a review or plan, ask for explanations | | yes | yes |
| fork | yes | yes | yes |
| cancel, resume, re-dispatch, rebase | | | yes |
| post a review, publish or approve a plan, anything that reaches GitHub or the tracker | | | yes |
| change the share | | | yes |

**Write means talking to the agent, not controlling the work.** Anything that reaches GitHub or the
tracker stays with the owner, because it happens with the owner's credentials under the owner's
name.

**Write mode spends the owner's subscription.** The session runs in the owner's workspace on the
owner's login, so a viewer's message is the owner's usage. The share popup says so before you choose
`write`.

**Every message says who sent it.** A message from a viewer reaches the agent as
"Message from Bob (shared with write access):" rather than "Message from the operator:". The daemon
fills the sender from the connection the message came in on, and the inbox stamps it
([runner.md](runner.md#the-protocol)). It's stored with `by` on the activity line and on the chat
turn, and shown that way to everyone.

### Transcripts without waking pods

Viewers read finished sessions far more often than live ones. Waking a workspace pod to read a
file would be slow and wasteful. The runner already streams each session's transcript to the daemon
as it's written (`session.transcript`), and the daemon keeps a copy in its state directory
([runner.md](runner.md#the-two-synchronous-questions)). A viewer reads that copy.

## Forks

Forking makes a copy of someone's item that **you** own: in your namespace, with your credentials,
on your subscription. The original is untouched.

1. You press fork on a shared item (or one of your own).
2. Your client (TUI or browser) asks the gateway to fork it (`POST /v1/fork/<user>/<item>`).
   Daemons can't reach each other, and never call the gateway, so the gateway does the carrying:
   it asks the owner's daemon for a **fork bundle** over a viewer connection as you, and the owner's
   daemon checks that the share lets you see the item before it builds one. The gateway then hands
   the bundle to your daemon as a `fork` command on your own connection.
3. The bundle holds:
   - the item's metadata: the issue, instructions, model
   - the transcript of the session being forked
   - the code. If the branch is pushed, that's just its name, and your workspace fetches it from
     GitHub with your token. If it isn't, it's a `git bundle` of the commits beyond the base, made by
     the owner's runner.
4. Your daemon creates a workspace, prepares it from the bundle on a new branch
   (`<branch>-fork-<you>`, through `prepare`'s `branch` or `bundle` source), puts the transcript in the agent's config directory, and resumes it as
   a new session. With Claude Code that's `--resume <id> --fork-session`.

The fork is a new task in your store. It doesn't move the issue's state in the tracker, and it
doesn't touch the original's PR. If you open a PR from it, that's a second PR, made by you.

Forking needs `capabilities.resume` and a runtime that can start a new session from a copied
transcript. A new capability, `fork`, says which runtimes can. A runtime without it can still be
forked as code and metadata, with a fresh session that's told what came before.

## Costs

Every daemon already keeps a spend ledger: each session's tokens, model and price (`core/spend.ts`).
In a cluster, one daemon is one user, so **per-user cost is each daemon's ledger**, with no new
accounting.

- **You** see your own in `:costs`, as today.
- **An org admin** (`ColiOrg.users.admins`) sees every user's totals through `/v1/costs`. The gateway asks
  each daemon for a summary: totals per day, per model and per kind of work. The admin doesn't see
  items or transcripts.
- **Write-mode usage** is the owner's spend, as it actually was. Each ledger entry made from a
  viewer's message also records `by`, so the owner can see who spent it.

## Open questions

- **Revoking a share.** Live viewer connections close at once, and the index entry goes. But a fork
  already made is the forker's and stays. That's the intended behaviour; is it what people expect?
- **Sharing outside the org's tailnet.** Out of scope. Worth a decision before someone asks.
- **Transcript copies and retention.** The daemon's copy follows the item's `retentionDays`. Should
  shared items be kept longer?
