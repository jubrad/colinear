# `:sessions` — your Claude Code and Codex conversations

Aliases: `sess`, `claude`, `codex`. Every conversation Claude Code and Codex have on this machine,
newest first: when it was last written to, which CLI, where it ran, the branch, and its first prompt.
`enter` resumes the one under the cursor in this terminal, in the directory it ran in
(`claude --resume <id>` or `codex resume <id>`). Quit the CLI to return to colinear.

By default the list holds the sessions **you** had at a terminal or in an editor. Programs run
sessions too: colinear's own agents, other SDK scripts, `codex exec`. `h` adds those. Where
colinear ran one, the `BY` column names what it was for: a task (`CLO-142`), a review, a plan.

| key | what |
|---|---|
| `i` `k` / ↑ ↓ | move · `g` top · `G` bottom |
| `enter` | resume it here, where it ran |
| `/` | filter by CLI, directory, branch, what it was for, or the first prompt |
| `,` | sort — the [sort bar](../README.md#sorting) |
| `h` | show or hide the sessions programs ran |
| `u` | read the sessions again |

Sessions are read from `~/.claude/projects` and `~/.codex/sessions` on the daemon's machine, so with
a [remote daemon](../configuration.md) they're that machine's and resume there. Only the most recent
300 are listed, and only the head of each transcript is read, so the list opens in a fraction of a
second however much history you have.
