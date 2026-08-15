# CLAUDE.md

Read DESIGN.md first — architecture, code map, task lifecycle, and the rendering gotchas that are easy to regress. README.md covers user-facing behavior.

## Commands

```bash
npm run dev          # run from source (tsx)
npx tsc --noEmit     # typecheck — must be clean before every commit
npm run build        # rebuild dist (the linked `coli` bin runs dist, not src)
npm run check        # CDC replay: the client mirror must match the daemon's store
npm run doctor       # env sanity: claude CLI, gh, Linear key, repos
coli daemon status   # is the backend up? (`stop` to kill it — that aborts live agents)
```

Smoke boot: `LINEAR_API_KEY=lin_api_dummy script -q /dev/null timeout 5 npm run dev >/dev/null 2>&1` — board chrome means it rendered. This **starts a daemon against your real config and state**; `coli daemon stop` when done, and never enqueue fake issues into it.

To exercise anything config- or state-shaped without touching live work, run against a throwaway `HOME` (`HOME=/tmp/x npx tsx src/index.tsx contexts`) or set `COLINEAR_STATE_DIR` — both give the run its own config, socket, pidfile and state.

## Rules

- Trust `npx tsc --noEmit`, not editor diagnostics (chronically stale in this repo).
- Always `npm run build` after changes so `coli` picks them up; typecheck + build before committing; push to origin main after committing.
- Runtime debugging: `~/.local/state/colinear/colinear.log` (includes diverted stderr — React warnings land there).
- Never set `ANTHROPIC_API_KEY` — agents bill the Claude subscription via the logged-in CLI.
- Rendering invariants (see DESIGN.md "Rendering gotchas"): root renders rows-1 with overflow hidden; stable identities from useTasks; DEC-2026 frame wrapping; no ambiguous-width glyphs in chrome.
- Prompts and posting live in the daemon: a rebuild needs `coli daemon stop && coli`, since `R` only reloads the frontend.
- Nothing reaches GitHub or Linear without the operator asking. Review posting is a deterministic `gh api` call, never a session — an agent can report a success its own tool call didn't have.
- Two processes: the daemon owns the dispatcher/store/persistence, the TUI mirrors it over a socket. Views must stay agnostic — read through the store API, write through it (mirrors forward, never mutate locally), and put decisions that depend on backend results in the dispatcher, not the view.
- No test suite; verification is typecheck + build + check + smoke + dogfooding.
- Keep README.md and DESIGN.md current when behavior changes.
