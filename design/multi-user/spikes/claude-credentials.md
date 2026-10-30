# Spike 0.1: how the Claude CLI treats its credentials

Three questions decide how token sync works for agents ([credentials.md](../credentials.md#claude-and-codex)):

1. Does the CLI run with an **access token and no refresh token**?
2. Does it **re-read a replaced credentials file** during a session, or keep the token in memory?
3. Is there a command that **forces a renewal** without starting a session?

**Run this in a Linux container, not on macOS.** On macOS the CLI keeps its login in the Keychain,
so there's no file to swap. On Linux it's `$CLAUDE_CONFIG_DIR/.credentials.json`, which is what a
workspace pod will have.

**Use a throwaway login.** Sign in fresh inside the container rather than copying your laptop's
credentials in. A copy would share a refresh token with your laptop, and either one renewing would
log the other out (rule 4 in credentials.md). Sign it out afterwards.

**Don't print token values.** Every step below shows only the file's keys and expiry times.

## Setup

```bash
docker run --rm -it --name coli-spike node:22-bookworm-slim bash
# inside:
apt-get update && apt-get install -y --no-install-recommends jq ca-certificates
npm install -g @anthropic-ai/claude-code
export CLAUDE_CONFIG_DIR=/spike/claude && mkdir -p "$CLAUDE_CONFIG_DIR"
claude            # sign in with your subscription; it prints a link and asks for the code; then /exit
F="$CLAUDE_CONFIG_DIR/.credentials.json"
jq 'walk(if type == "string" and length > 40 then "<redacted>" else . end)' "$F"   # the file's shape
cp "$F" /spike/full.json
```

Record the shape. The design assumes `claudeAiOauth.{accessToken, refreshToken, expiresAt}`. If
it's different, note what it is.

## Question 1: access token only

```bash
jq 'del(.claudeAiOauth.refreshToken)' /spike/full.json > /spike/access-only.json
cp /spike/access-only.json "$F"
claude -p 'reply with the word ok'
```

- **Works:** pods can receive the access token alone.
- **Fails:** note the error. Then try with `refreshToken` set to an empty string instead of removed.

## Question 2: is the file re-read mid-session?

Start a session that takes several turns, and break the file between turns.

If question 1 failed, use `/spike/full.json` wherever this says `access-only.json`. The question
is the same either way: does a running session notice the file changing under it?

```bash
cp /spike/access-only.json "$F"
claude          # interactive. Turn 1: "reply ok". Leave it open.
```

In a second shell (`docker exec -it coli-spike bash`, then set `F` again):

```bash
jq '.claudeAiOauth.accessToken = "invalid"' /spike/access-only.json > "$F.tmp" && mv "$F.tmp" "$F"
```

Back in the session, turn 2: "reply ok again".

- **Turn 2 fails with an auth error:** the CLI re-reads the file. Token sync can swap the file under
  a running session.
- **Turn 2 works:** the CLI keeps the token in memory. Sessions need the restart-and-resume fallback
  to outlive a token.

Restore the file (`cp /spike/access-only.json "$F"`), then repeat the test with the colinear way of
running a session: the Agent SDK's streaming input. `coli` itself in the container is the easiest
harness: dispatch something long and swap the file between turns.

## Question 3: forcing a renewal

With the full file back in place and its expiry moved into the past:

```bash
jq '.claudeAiOauth.expiresAt = 0' /spike/full.json > "$F"
claude --help | grep -i -E 'auth|login|token'     # any status or refresh command?
claude auth status 2>&1 | head -5                  # if it exists
jq '.claudeAiOauth.expiresAt' "$F"                 # did it change?
```

- **The expiry moved forward** after a command that starts no session: that command is how the
  daemon renews.
- **Nothing changed:** try `claude -p 'ok'` (a real, tiny session) and check again. If only a session
  renews, the daemon's renewal costs one tiny session per renewal. That's acceptable, but worth
  knowing.

Also note `expiresAt - now` on a fresh token. That's the access token's lifetime, which sets how
often the daemon renews.

## Clean up

```bash
claude             # then /logout; note whether it revokes the login or only deletes the file
exit
```

## Record the answers

Put the results in [credentials.md](../credentials.md#claude-and-codex), replacing the three
questions with what was found, and tick 0.1 in [WORK-ORDER.md](../WORK-ORDER.md).
