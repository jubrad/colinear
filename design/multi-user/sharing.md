# Sharing, forks and costs

By default nobody sees anything of yours. You can share a piece of work with named people or with
everyone signed in. **Sharing is read-only, and forkable.** Someone you share with can read it and
can fork it into their own account, where it runs on their own logins. Nobody ever talks to an agent
running on someone else's credentials. Why, and what collaboration might look like later, is
[below](#why-sharing-isnt-collaborative).

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

| | viewer | owner |
|---|---|---|
| see the card, activity, diff, review doc, plan | yes | yes |
| read every session's transcript | yes | yes |
| fork | yes | yes |
| message the agent, answer its questions, chat in a review or plan | | yes |
| cancel, resume, re-dispatch, rebase | | yes |
| post a review, publish or approve a plan, anything that reaches GitHub or the tracker | | yes |
| change the share | | yes |

A viewer connection accepts one command, `fork`. Everything else is refused by the owner's daemon.

### Sharing doesn't get around repo permissions

An item carries its repo's code: the diff, the transcripts, and for a fork, any unpushed commits.
If Alice shares a task on a private repo that Bob can't read, showing it to him would leak that repo.

So **a viewer must be able to read the item's repo with their own GitHub login.** Before opening a
view or carrying a fork, the gateway asks the *viewer's* daemon whether their GitHub connection can
read the repo, and puts the verified answer in the `viewer` frame
([gateway.md](gateway.md#protocol)). The owner's daemon refuses an item whose repo isn't in it. A
viewer with no GitHub connection sees nothing that carries code.

### Transcripts without waking pods

Viewers read finished sessions far more often than live ones. Waking a workspace pod to read a
file would be slow and wasteful. The runner already streams each session's transcript to the daemon
as it's written (`session.transcript`), and the daemon keeps a copy in its state directory
([runner.md](runner.md#the-two-synchronous-questions)). A viewer reads that copy.

## Forks

Forking makes a copy of someone's item that **you** own: in your namespace, with your credentials,
on your subscription. The original is untouched. It's how you build on someone else's work.

1. You press fork on a shared item (or one of your own).
2. Your client (TUI or browser) asks the gateway to fork it (`POST /v1/fork/<user>/<item>`).
   Daemons can't reach each other, and never call the gateway, so the gateway does the carrying:
   it asks the owner's daemon for a **fork bundle** over a viewer connection as you, and the owner's
   daemon checks that the share lets you see the item, and that you can read its repo, before it
   builds one. The gateway then hands
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
- **A fork's usage is the forker's**, because it runs on their subscription. Sharing never moves
  spend from one person to another.

## Why sharing isn't collaborative

Letting a viewer talk to the owner's agent, a "write mode", was designed and dropped:

- **It shares the owner's credentials, not just their authority.** The agent can read the token
  files in its own pod, so a viewer could ask it to print them.
- **It spends the owner's subscription** on someone else's say-so.
- **Claude can't be routed through a proxy**, so a turn runs on whichever login the agent process
  holds. There's no way to make one turn of a shared session run on the viewer's account.

Three other approaches were rejected:

- **A shared content volume with per-user credential volumes.** One agent process runs on one
  subscription and can read everything mounted into its pod, so mounting a second user's
  credentials hands them to whoever is driving. Sharing a volume across namespaces also breaks the
  namespace boundary, and the cloud volumes in use attach to one node at a time.
- **A tool the agent calls to fetch the current speaker's credentials.** The model would be choosing
  whose credentials to use, which a prompt injection could steer, and the token would land in its
  context. Credentials are chosen by code, never by the model.
- **Routing each turn through the speaker's own daemon.** Possible for GitHub actions, which the
  daemon could make, but not for the model calls themselves, for the proxy reason above.

If collaboration is wanted later, two shapes keep every turn on the right person's logins:

- **Suggestions.** A viewer's message lands in the item's discussion as "Bob suggests: …", and the
  owner decides whether to send it to their agent.
- **Taking the wheel.** The conversation and branch move to the other person's own workspace and
  logins, and the original pauses. One driver at a time, handed back and forth. It's forks plus a
  hand-back.

## Open questions

- **Revoking a share.** Live viewer connections close at once, and the index entry goes. But a fork
  already made is the forker's and stays. That's the intended behaviour; is it what people expect?
- **Sharing outside the org's tailnet.** Out of scope. Worth a decision before someone asks.
- **Transcript copies and retention.** The daemon's copy follows the item's `retentionDays`. Should
  shared items be kept longer?
