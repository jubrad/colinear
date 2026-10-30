# The web UI

A browser client for the same daemon, over the same protocol the TUI uses. It doesn't replace the
TUI. It exists for:

- people who won't live in a terminal
- links: a shared item you can open from Slack
- things a terminal does badly: long transcripts, side-by-side diffs, cost charts

## Shape

- **React + TypeScript**, built with Vite, in `web/` in this repository. The gateway serves the
  built assets at `/` ([gateway.md](gateway.md#routes)).
- **It shares the client core with the TUI.** The protocol types (`core/protocol.ts`), the
  snapshot-plus-change-log mirror (`core/delta.ts`, the client store) and the domain types
  (`core/types.ts`) become a browser-safe module that both clients import. The mirror logic is the
  part that's easy to get subtly wrong, and DESIGN.md's "the mirror follows a log" section exists
  because it was. It shouldn't be written twice.
- **No Node APIs in that shared module.** Today `protocol.ts` imports `node:path` for the socket
  path. That moves out, and a lint rule keeps Node imports out of the shared module.
- **Same identity.** The browser reaches the gateway over the tailnet, so `serve` supplies the user
  exactly as it does for the TUI. No separate web login.

## Views, in the order they're built

1. **Board**: the columns, cards and statuses.
2. **Task**: activity, the agent's conversation in full, questions answered with a form, `M`.
3. **Shared with me**: the `ColiShare` index, opening into a read-only view with a fork button.
4. **Reviews**: the diff with findings in the margin, and the review chat. The data is the same as
   the TUI's `AnnotatedDiff`; the browser just has room for it.
5. **Connections**: sign in to each service ([credentials.md](credentials.md#connections)).
6. **Costs**: yours, and the org's for admins.
7. **Agents**: every session, live and finished.

Attach (`s`, `S`) comes last, as a terminal in the page (xterm.js on the same pty stream the TUI
uses). Most of what attach is used for, the web UI shows directly.

## Principles carried over from the TUI

- **Anything sent to an agent shows that it's working**, from the moment you act until the answer
  lands, and **replies appear in full**. The same rule as the TUI's `Working` and `ChatLog`.
- **Nothing reaches GitHub or the tracker without you asking.** Every posting action is an explicit
  button with a confirmation, never a side effect.
- **The daemon decides; the view displays.** Views read the mirror and send commands, the same
  contract the TUI's views have.

## Testing

Playwright against the kind cluster from `bin/kind-up`, as part of `bin/e2e`:

- sign in as a development user
- see the board
- open a shared item as a second user
- check that a read-only viewer has no message box

## Open questions

- **Design system.** Reuse the TUI's theme tokens as CSS variables, or start fresh? Reusing them
  keeps the two recognisably the same product.
- **Mobile.** Read-only on a phone (checking on a task, answering a question) is probably worth it.
  Anything more probably isn't.
