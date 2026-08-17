# `:config` — resolved configuration

Alias: `cfg`. What colinear actually loaded, with the API key masked.

It also names the **provider**, what that provider calls a scope (team / project / repo), and
anything it can't do — a capability that's off means the feature depending on it is switched off, and
this is where you find out.

If more than one [context](../configuration.md#contexts) exists, they're listed with the active one
highlighted.

| key | what |
|---|---|
| `e` | open the config in `$EDITOR`. Changes apply when you come back |

The full option list is in [configuration](../configuration.md). Note that prompts, dispatch and
polling live in the daemon: `R` reloads the frontend, but a change to daemon behaviour needs
`coli daemon stop && coli`.
