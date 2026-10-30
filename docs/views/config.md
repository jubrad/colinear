# `:config` — resolved configuration

Alias: `cfg`. What colinear actually loaded, with the API key masked.

It also names the **provider**, what that provider calls a scope (team / project / repo), and
anything it can't do — a capability that's off means the feature depending on it is switched off, and
this is where you find out.

If more than one [context](../configuration.md#contexts) exists, they're listed with the active one
highlighted.

Each top-level key says where its value came from: `default` (built in), `yours` (your config file),
`org`, or `org+yours` for the keys that combine both, such as `denyTools`. `org` only appears
when the daemon follows an [org config](../configuration.md#org-config), which is how a colinear
cluster sets defaults and locks for everyone. A locked key is marked `locked`. Under
**set but not applied** is anything a config set that the merge refused, with the reason: a locked
key you changed, a model the org doesn't allow, a permission mode looser than the org's. That's where
you see why an edit didn't take.

| key | what |
|---|---|
| `e` | open the config in `$EDITOR`. Changes apply when you come back |
| `j` / `k` | scroll; space and page down/up move a page, `g` and `G` jump to the top and the bottom |

The full option list is in [configuration](../configuration.md). Note that prompts, dispatch and
polling live in the daemon: `R` reloads the frontend, but a change to daemon behaviour needs
`coli daemon stop && coli`.
