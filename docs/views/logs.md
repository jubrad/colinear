# `:logs` — the debug log

Aliases: `log`, `debug`. Everything colinear is doing, including stderr diverted while the TUI owns
the screen — React warnings and SDK noise land here rather than tearing the display.

| key | what |
|---|---|
| `j` `k` scroll · `space` page · `g` top · `G` follow |
| `/` | filter |

The file is `~/.local/state/colinear/colinear.log` (per [context](../configuration.md#contexts)), so
`tail -f` works too. It's the first place to look when behaviour is strange.
