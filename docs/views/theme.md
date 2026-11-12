# `:theme` — colour themes

Aliases: `themes`, `colors`. No argument.

Pick a theme by trying it. Moving the cursor switches the whole UI at once, including the header,
the crumbs and the sample under the list, so you judge it against the real thing. `enter` keeps it,
and `esc` puts back the one you came in with. The choice is remembered across restarts, like the
board's layout.

| theme | for |
|---|---|
| `colinear` | the default: the k9s-inspired palette colinear has always had |
| `terminal` | the 16 ANSI colours only, so it follows whatever palette your terminal has — light or dark |
| `catppuccin-mocha` | dark |
| `catppuccin-latte` | light |
| `dracula` | dark |
| `nord` | dark |
| `gruvbox-dark` | dark |
| `tokyo-night` | dark |
| `solarized-dark` | dark |

Themes colour text and borders; the background is always your terminal's, because Ink never paints
it. So a light theme wants a light terminal. If you switch terminal palettes often, `terminal` is the
one that keeps up.

| key | what |
|---|---|
| `j` `k` / ↑ ↓ | try a theme · `g` first · `G` last |
| `enter` | keep it |
| `esc` | put back the theme you had and go back |

## Adding one

A theme is a value for each of sixteen tokens in `src/theme.ts`: `key`, `accent`, `ok`, `warn`,
`err` and the rest, each one a role rather than a colour. Ink takes hex or ANSI names. Add an entry to
`THEMES` and it appears here. `bin/check` fails on any colour written outside `theme.ts`, because a
literal colour in a view stays the same in every theme.
