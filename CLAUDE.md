# CLAUDE.md

Read DESIGN.md first — how it works (processes, CDC sync, the task state machine, the clocks) and the rendering gotchas that are easy to regress; CODEMAP.md is the file-by-file map. README.md is the public overview; `docs/` is the user-facing reference (one page per view, plus getting-started, security, configuration, CLI) and must be kept current with behaviour changes.

## Commands

```bash
bin/check            # the gate CI runs: lint, build, CDC replay
bin/lint             # typecheck + docs lint (fast; what a pre-commit hook runs)
bin/gen-docs --serve # regenerate the views table, build the docs site, browse it
npm run dev          # run from source (tsx)
npm run build        # rebuild dist (the linked `coli` bin runs dist, not src)
npm run doctor       # env sanity: claude CLI, gh, Linear key, repos
coli daemon status   # is the backend up? (`stop` to kill it — that aborts live agents)
```

Anything runnable — a lint, a gate, a generator — lives in `bin/` as a script you can run by hand, not buried in a workflow or an npm alias; CI calls the same script you do. A generator takes `--check`: it writes nothing and fails if the tree would change, so "the docs are current" is one command.

The docs site is `bin/gen-docs`: it regenerates the views table in `docs/README.md` from `src/views/registry.ts`, checks every view has a page and every alias is documented, then builds `docs/` with mkdocs into `site/`. Staging symlinks the repo layout, so a relative link that works on GitHub works on the site — don't add site-only link rewriting. Prose is written by hand; the generator owns the table between its markers and nothing else. It needs mkdocs **with the Material theme** (a bare `mkdocs` on PATH fails with "Unrecognised theme name"), so it provisions a pinned `.venv-docs/` unless the environment already has one; `--no-site` skips all of that for the lint path.

Smoke boot: `LINEAR_API_KEY=lin_api_dummy script -q /dev/null timeout 5 npm run dev >/dev/null 2>&1` — board chrome means it rendered. **Judge it by the rendered output and the log, never by `$?`:** macOS `script` does not propagate its child's status (`script -q /dev/null timeout 2 sleep 10` exits 1, not 124), and it sometimes fails to allocate a tty at all (`script: tcgetattr/ioctl: Operation not supported on socket`) — in both cases the harness is lying, not colinear. Grep the frame for box-drawing characters, and re-run before believing a failure. This **starts a daemon against your real config and state**; `coli daemon stop` when done, and never enqueue fake issues into it.

To exercise anything config- or state-shaped without touching live work, run against a throwaway `HOME` (`HOME=/tmp/x npx tsx src/index.tsx contexts`) or set `COLINEAR_STATE_DIR` — both give the run its own config, socket, pidfile and state.

Screenshots (`docs/images/`) are captured from `coli demo` in a real pty — [ttyd](https://github.com/tsl0922/ttyd) on localhost driven by a browser — because a headless render harness verifies views but not daemon behaviour; the real pty is what caught the three demo bugs in PR #34. Two things bite: **start `coli` after sizing the window** (Ink draws to the size it had at boot), and **after every resize, toggle `term.options.fontSize` to force xterm to re-init its canvas** — browser viewport emulation drops `devicePixelRatio` to 1 while the backing store is still 2x, which renders the whole terminal at half scale. 1680×790 at fontSize 16 gives 183×41, the first width where the header's key grid stops truncating.

## Rules

- Trust `npx tsc --noEmit`, not editor diagnostics (chronically stale in this repo).
- Always `npm run build` after changes so `coli` picks them up; typecheck + build before committing; push to origin main after committing.
- Runtime debugging: `~/.local/state/colinear/colinear.log` (includes diverted stderr — React warnings land there).
- Never set `ANTHROPIC_API_KEY` — agents bill the Claude subscription via the logged-in CLI.
- Edits go in a `Popup` over the view they came from (ui/Popup.tsx: it must render *last*, and it needs an explicit height); full screen is only for whole surfaces like the config editor and the review split. See DESIGN.md.
- Rendering invariants (see DESIGN.md "Rendering gotchas"): root renders rows-1 with overflow hidden; stable identities from useTasks; DEC-2026 frame wrapping; no ambiguous-width glyphs in chrome.
- Prompts and posting live in the daemon: a rebuild needs `coli daemon stop && coli`, since `R` only reloads the frontend.
- Talk to the issue tracker through `providerFor(cfg)` only — nothing outside `core/providers/` may import a tracker client, and features gate on `capabilities` instead of assuming Linear's model.
- Nothing reaches GitHub or Linear without the operator asking. Review posting is a deterministic `gh api` call, never a session — an agent can report a success its own tool call didn't have.
- Two processes: the daemon owns the dispatcher/store/persistence, the TUI mirrors it over a socket. Views must stay agnostic — read through the store API, write through it (mirrors forward, never mutate locally), and put decisions that depend on backend results in the dispatcher, not the view.
- No test suite; verification is typecheck + build + check + smoke + dogfooding.
- Keep DESIGN.md, README.md and `docs/` current when behavior changes — a new view needs a `docs/views/<name>.md` (the index row is generated; `bin/gen-docs` fails without the page); a new config option needs a row in `docs/configuration.md`.
