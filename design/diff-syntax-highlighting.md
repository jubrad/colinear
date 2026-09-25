# Design: syntax highlighting in the diff view

Status: **implemented** on branch `diff-syntax-highlighting`. Touches `src/core/diff.ts`,
`src/ui/AnnotatedDiff.tsx`, `src/core/diff.check.ts`, and `src/core/highlight.ts` (new). See
"Implementation" at the end for what shipped and the one limitation that remains.

## What and why

The annotated diff (`:reviews` → `enter`, and `:diff` against a task's own branch) renders code with
no syntax colour: add lines are green, del lines red, everything else plain. Reading a Rust or Go
diff — which is most of what gets reviewed here — is harder than it should be because the eye has no
structure to grab. This proposes syntax highlighting for the code column, kept inside the existing
palette and the existing width guarantees.

The whole feature is one shape of work — turning a diff row from a string into a list of coloured
spans — and one taste call about which colours. The tokenizer is the smallest part.

## Non-goals

- **LSP / semantic tokens.** Rejected. Review checkouts are cut per PR and thrown away; rust-analyzer
  or gopls must index a whole workspace before answering, paid per review to colour a four-file diff —
  the cost model is backwards. Semantic tokens mostly distinguish a type from a variable, which is not
  what a reader is squinting at. Hover types / go-to-definition would be a *different* feature against
  the long-lived main checkout, out of scope here.
- **A second render path.** `:reviews` and `:diff` share `AnnotatedDiff`; both get this or neither does.
- **Perfect lexing.** See "whole-file tokenizing" — we can do better than a fragment lexer, but a token
  map is still approximate at the edges. The design makes a wrong lex *fail the gate*, not mislead the reader.

## Current shape (what we are changing)

`src/core/diff.ts`:
- `DiffLine { kind, text, file, newLine?, oldLine? }` — one parsed diff line, `text` a plain string.
- `toVisualRows(lines, width): VisualRow[]` — wraps long lines; `VisualRow { line, text, first }`,
  `text` a plain-string slice of the line, `first` false on the wrapped remainder.
- `expandTabs` already runs at parse time so one character is one column downstream.

`src/ui/AnnotatedDiff.tsx`:
- `parseDiff` memoised at `:113`, `toVisualRows` at `:117` — both keyed on the diff, not the frame.
- `DiffRow` renders three `<Text>` spans: the gutter marker, the padded line number, and
  `{sign}{line.text}` coloured `color={onCursor ? undefined : color}` where `color` is `theme.ok`
  for add, `theme.err` for del, `undefined` for context.

`src/core/diff.check.ts`:
- Asserts, at every pane width, that each visual row fits the pane in **painted columns** (`drawnColumns`,
  the guard that caught the tab bug) and that wrapping is **lossless** (`joined === line.text`).

## Design

### 1. The row model becomes spans

`VisualRow.text: string` becomes a span list — `Array<{ text: string; token?: TokenKind }>`. `DiffRow`'s
third `<Text>` becomes a map over spans, each `<Text>` coloured from the token. This is the real work;
everything else follows from it.

Three things ripple, and each is a place the tab bug's lesson applies:

- **`toVisualRows` slices after tokenizing, not before.** Wrapping must cut a *span list* at a column,
  not a raw string — cut a raw string and a token gets split at the wrap boundary and everything after
  the break mis-colours. The slice keeps operating in painted columns (`drawnColumns`), so the width
  guarantee is unchanged; it just carries token boundaries through.
- **`diff.check.ts` grows two invariants and keeps its old one.** New: the concatenated span text equals
  the original line (lossless, as today, now over spans), and the span widths sum to `drawnColumns(line)`
  (so the width guard still holds — this is the assertion that stopped the tab overflow, moved onto the
  span model). A wrong flatten that drops or duplicates a character fails here.
- **`onCursor` collapses colour.** A cursor row is drawn `inverse`; spans must render with no token colour
  under the cursor, exactly as `color={onCursor ? undefined : color}` does today.

Node count roughly triples for the code column (~120 → ~320 Ink nodes for a 40-row pane). That is fine
**only if tokenizing is memoised per diff**, alongside the existing `parseDiff`/`toVisualRows` memos —
never per frame, because the app re-renders on a clock. Tokenize once when the diff arrives; the frame
loop only maps existing spans to `<Text>`.

### 2. Colour: sign column and gutter carry add/del; syntax carries the code

This is the decision from the design discussion. Today the add/del colour *is* the code foreground.
Syntax wants that same channel, so we move add/del off it:

- The **sign column** (`+`/`-`) and the **gutter** keep green/red. That is where "what changed" now lives.
- The **code foreground** is free for syntax.
- A **removed (`-`) row is dimmed whole**, syntax colours included, so "what is going away" recedes without
  spending a colour. This also makes an approximate lex on removed lines cheap (see whole-file tokenizing).

Green (`theme.ok`) and red (`theme.err`) stay **reserved** for the sign/gutter — a green string literal on
an added line would fight the sign. Syntax tokens draw from the rest of the palette (`src/theme.ts`):
`key` (#ff8700), `accent` (cyan), `info` (magenta), `annotation` (#5fafff), `warn` (yellow), `dim` (gray).
A starting token→colour map (a taste call, cheap to change, worth a real pass against light and dark):

| token | colour | note |
|---|---|---|
| comment | `dim` | recedes, matches "not the code" everywhere else |
| string | `warn` | yellow reads as literal, not reserved |
| keyword | `key` | the orange the UI already uses for keys |
| number / constant | `annotation` | blue |
| type / class | `accent` | cyan |
| function / call | default fg | leave the bulk uncoloured; colour the frame, not every token |
| everything else | default fg | |

Colour the frame, not every identifier — an over-coloured diff is as hard to read as an uncoloured one.

### 3. Tokenize whole files, not the hunk

The key insight from how editors do this. **No editor highlights a fragment.** Vim needs `:syntax sync`
heuristics to re-scan far enough back that a block comment opened above the viewport doesn't mis-colour
everything below; tree-sitter (helix, neovim) parses the whole buffer. A diff hunk is exactly the fragment
both are working around, and `delta`/`bat` accept the resulting inaccuracy.

**Correction from implementation.** The design assumed the highlighter could read the new-side file
from the review worktree. It cannot: highlighting runs in the TUI, which receives only the diff
*string* over the socket, and the worktree lives on the daemon's machine — a remote daemon puts it out
of reach entirely. Reading files here would be wrong.

So the shipped approach is **per hunk, from the diff string**. A hunk's lines are consecutive, so the
new-side block (context + additions) and the old-side block (context + deletions) are each tokenized
whole and cut back apart at the newlines. That colours any multi-line construct **contained in the
hunk** correctly — the common case, and everything `delta`/`bat` get wrong. The only residue is a
construct opened *before* the hunk's first line, outside the diff; closing that needs the whole file,
which only a daemon-side pass (tokenize there, send spans) could supply — a wire-format change worth
making only if the residue ever bites. Removed lines are lexed from the old-side block and dimmed
whole (§2), so they cost nothing extra.

### 4. The tokenizer

Per-language rules are unavoidable — the question is only whether we write them or import them. Vim proves
the table approach works, at a corpus (hundreds of `syntax/*.vim` files, thirty years) we cannot replicate.
Helix imports grammars through tree-sitter's three layers (grammar / queries / theme). The menu:

| option | accuracy | cost |
|---|---|---|
| hand-rolled table (comments + strings, ~6 langs) | Vim-class, corpus of 6 | ~100 lines, no dep; misleads on Rust `r#"…"#`, Go backtick raw strings, SQL `"` identifiers |
| Prism `tokenize` | Vim-class, corpus of ~290 | small dep, returns a token **tree** (flatten to spans), per-language grammar registration, CJS/ESM friction |
| `web-tree-sitter` + queries | Helix-class | MBs of wasm across our languages, three layers, per-language init latency |

**Recommendation: Prism `tokenize` with whole-file tokenizing as the first cut; tree-sitter as the upgrade
path if the colouring ever misleads.** `Prism.tokenize(code, grammar)` returns a real token array (unlike
highlight.js, whose public API returns HTML); grammars load per language, so we pay for the ones we register.
Given the repo reviews Rust and Go — where raw strings and struct tags are exactly the edge cases regex
lexers get wrong — the table is too risky as the primary, but it stays the fallback for the handful of
languages we look at most if Prism's integration turns ugly.

Two integration risks to spike before committing:
- **Prism ships CJS**, and colinear is ESM with NodeNext resolution; grammar registration
  (`prismjs/components/prism-go`) mutates a global and is awkward under ESM. This is the real risk, not the lexing.
- **Nested tokens.** Prism returns a tree (a template literal contains interpolations contain expressions);
  it must flatten to a span list whose widths sum to the line — which is exactly the invariant
  `diff.check.ts` already asserts, so the check catches a bad flatten.

A language with no registered grammar renders plain — today's behaviour, never worse than now.

## Rollout

Four stages, each shippable and provable on its own:

1. **Span row model, no colours.** `VisualRow.text` → spans, `DiffRow` maps them, `toVisualRows` slices
   spans, `diff.check.ts` grows the two span invariants. Purely mechanical; the diff looks identical; the
   gate proves losslessness and the width guarantee still hold. De-risks everything downstream.
2. **Prism spike + whole-file tokenize for one language** (TypeScript, so we dogfood on this repo's own PRs).
   Proves the CJS/ESM path, the flatten, the worktree read, and the token→colour map end to end.
3. **The rest of the languages** (Rust, Go, Python, SQL, YAML, HCL) — a grammar registration and a check
   fixture each; the colour map does not change.
4. **tree-sitter**, only if stage 2/3 colouring measurably misleads.

## Test strategy

Extend `src/core/diff.check.ts` (the file that made the tab fix safe):

- **Lossless over spans:** concatenated span text equals `line.text`, at every pane width.
- **Width preserved:** span widths sum to `drawnColumns(line)` — the guard that caught the tab overflow,
  now on the span model.
- **Per-language token fixtures:** a small diff per language asserting the expected token spans on the
  cases regex lexers get wrong — a Rust `r#"…"#` raw string, a Go backtick string, an SQL `"identifier"`
  vs `'string'`. A wrong lex **fails the gate** rather than mis-colouring silently in the one view whose
  job is catching bugs. This is the bargain `diff.check.ts` already makes: the fixture is what makes a
  risky change safe.

## Open questions

- Token→colour map in light vs dark, and whether `function`/`type` earn a colour or read better plain.
- Removed-line tokenizing: hunk-fragment lex vs default foreground — decide once dimming is on screen.
- Whether to gate stage 2 behind a config flag while the colour map settles, or ship dark and iterate.


## Implementation

Shipped on this branch; `bin/check` is green, including the syntax invariants. The flagship docs
screenshot (`docs/images/annotated-diff.png`) now shows it: keywords orange, numbers blue, comments
dim, strings yellow, ordinary identifiers plain, while the `+`/`-` sign and gutter keep green/red.

- **Row model.** `VisualRow` carries `spans: Span[]`; `toVisualRows` slices them in step with the
  text wrap via `sliceSpans`; `DiffRow` maps spans to `<Text>`; `onCursor` drops colour; a removed row
  is dimmed whole. `Span`/`TokenKind` live in `diff.ts`, still dependency-free. Tokenizing is memoised
  per diff alongside `parseDiff`, never per frame.
- **Per-hunk tokenizing** (see §3's correction) via Prism, which works under NodeNext ESM: `import
  Prism from 'prismjs'` gives the singleton, grammar components load synchronously with `createRequire`
  (no top-level await, so highlighting stays sync in the render memo), and the token tree flattens to
  spans that concatenate losslessly. `prismjs` is a runtime dep, `@types/prismjs` a dev dep.
- **Grammars load eagerly** in dependency order (bases first) — ~10ms once at TUI start, so no lazy
  loading needed. Languages: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, SQL, YAML, Markdown.
  Markdown maps onto the existing five kinds (heading→keyword, code→string, link→number, emphasis→type),
  so the palette is untouched. An unlisted extension renders plain.
- **The check** proves, at every pane width, that a row's spans concatenate to its text and their
  widths sum to `drawnColumns` (the tab guard, on spans), that `sliceSpans` is lossless at every cut,
  that a multi-line comment colours every line (per-hunk), and that the tokenizer classifies
  keyword/string/comment/markdown/tsx losslessly. A one-character mis-cut fails it four ways.

Deliberately not done:

- **The colour map** is the §2 table, unreviewed against light and dark — the one subjective choice,
  and the cheap part to change.
- **Whole-file (across-hunk) correctness** and **HCL/more grammars** — the residue in §3; a
  daemon-side pass if it ever matters.
- **No config flag.** Highlighting ships on: it is presentational, degrades to plain on any unknown
  language, and the check guards losslessness. A disable switch is a trivial follow-up if wanted.
