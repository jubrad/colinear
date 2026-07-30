# CLAUDE.md

Read DESIGN.md first — architecture, code map, task lifecycle, and the rendering gotchas that are easy to regress. README.md covers user-facing behavior.

## Commands

```bash
npm run dev          # run from source (tsx)
npx tsc --noEmit     # typecheck — must be clean before every commit
npm run build        # rebuild dist (the linked `coli` bin runs dist, not src)
npm run doctor       # env sanity: claude CLI, gh, Linear key, repos
```

Smoke boot: `LINEAR_API_KEY=lin_api_dummy script -q /dev/null timeout 5 npm run dev >/dev/null 2>&1; echo $?` — exit 124 = rendered and stayed alive.

## Rules

- Trust `npx tsc --noEmit`, not editor diagnostics (chronically stale in this repo).
- Always `npm run build` after changes so `coli` picks them up; typecheck + build before committing; push to origin main after committing.
- Runtime debugging: `~/.local/state/colinear/colinear.log` (includes diverted stderr — React warnings land there).
- Never set `ANTHROPIC_API_KEY` — agents bill the Claude subscription via the logged-in CLI.
- Rendering invariants (see DESIGN.md "Rendering gotchas"): root renders rows-1 with overflow hidden; stable identities from useTasks; DEC-2026 frame wrapping; no ambiguous-width glyphs in chrome.
- No test suite; verification is typecheck + build + smoke + dogfooding.
- Keep README.md and DESIGN.md current when behavior changes.
