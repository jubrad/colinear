# Getting started

## What you need first

| | why |
|---|---|
| The **`claude` CLI**, logged in | agents run on your Claude subscription. Leave `ANTHROPIC_API_KEY` unset — setting it bills the API instead |
| **`gh`**, authenticated | PRs, CI status, reviews |
| A **Linear API key** | Settings → Security & access → API keys. Not needed if you start with the local `sqlite` tracker |
| At least one **git repo** | agents work in worktrees cut from it, never in the checkout itself |

macOS is the tested platform. Node 20 or newer.

## Install

```bash
git clone https://github.com/jubrad/colinear && cd colinear
npm install       # installs dependencies, then builds dist
npm link          # puts `coli` (and `colinear`) on PATH
```

`dist/` is not in the repository, and the `coli` on your PATH is a symlink straight into it, so the
build has to happen before the link is worth anything. That is what the `prepare` script is for: npm
runs it on `npm install` and again on `npm link`, so neither step can leave you with a `coli` that
points at a file which was never built. If you skip `npm install` — a `git pull` onto an existing
clone, say — run `npm run build` yourself; the linked `coli` runs `dist`, not `src`.

## Configure

```bash
coli init
```

It asks which tracker first. **Pick `sqlite` if you just want to see it work** — that's a local
tracker in a file, no account and no key, and you can file issues with `coli issue add "…"`. Pick
`linear` for the real thing.

It asks for the tracker key, validates it by using it, offers a scope (your Linear team) from what comes back, and takes the repos agents may work in — suggesting the repository you're standing in and reading its default branch. Nothing is written until the end, and an existing config is never overwritten without a yes.

Scripted setups can skip the questions:

```bash
LINEAR_API_KEY=lin_api_… coli init --yes    # key from the env, repo from $PWD
```

Then check the pieces it can't check for you:

```bash
npm run doctor
```

## Your first dispatch

```bash
coli
```

1. You land on `:issues`. `/` filters, `t` switches team.
2. `enter` on an issue dispatches an agent. `c` opens the custom-dispatch popup first (instructions, model, repo, whether to triage).
3. The board opens. The card moves Queued → Triage → Working as the agent goes; it shows live duration, tokens, subtask progress and, once there's a PR, its CI and review state.
4. If the agent needs a decision the card lands in **Needs Input** — `a` opens the answer form. `e` in that form writes the questions to a markdown file and opens `$EDITOR` if your answer is longer than a line.
5. When it opens a PR the card moves to **PR Open**. It's a **draft**: agents never mark PRs ready. `enter` → `d` is how a PR becomes ready, and that's you.

## While it's running

- **`M`** messages a running agent without attaching — "use the existing helper", "don't touch the schema". An idle task is woken to read it.
- **`s`** hands your terminal to `claude --resume` in that task's worktree; quit claude and colinear offers to hand the conversation back to a headless agent.
- **`x`** cancels, **`r`** resumes, **`b`** rebases a conflicting PR.

## Where things live

| what | where |
|---|---|
| config | `~/.config/colinear/config.json` |
| task state, logs, socket | `~/.local/state/colinear/` |
| worktrees | `<repo>-worktrees/<ISSUE-KEY>` |

Agents outlive the UI: a daemon owns the work, the TUI is a client. Quitting, or `R` to reload on new code, doesn't stop anything. `coli daemon stop` does.

## Next

- [Security & blast radius](security.md) — worth reading before you dispatch against a repo you care about
- [Configuration](configuration.md) — checks, guidance, retention, contexts
- [Views](README.md#views) — one page per view
