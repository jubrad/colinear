# A colinear daemon in a container.
#
# Agents run *inside this container* — colinear runs their sessions in-process —
# so whatever your repos need to build and test has to be here too. Treat this
# as a base to extend, not a finished environment: see docs/docker.md.
FROM node:22-bookworm-slim

# git for worktrees, openssh-client for git+ssh and agent forwarding,
# gh for PRs and reviews, ripgrep because agents reach for it constantly
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg less openssh-client ripgrep \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# the agent runtime: subscription auth means this CLI, logged in (see docs)
RUN npm install -g @anthropic-ai/claude-code

# Run as your uid so worktrees the agents create stay yours on the host.
#   docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) .
ARG UID=1000
ARG GID=1000
# reuse whatever already owns that id: a macOS host's gid 20 (staff) is
# dialout in Debian, and uid 1000 is the node user — both make groupadd fail
RUN set -eux; \
    if ! getent group "$GID" >/dev/null; then groupadd -g "$GID" coli; fi; \
    if ! getent passwd "$UID" >/dev/null; then useradd -m -u "$UID" -g "$GID" coli; fi

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm link

# state (and therefore the socket the TUI connects to) lives here
ENV COLINEAR_STATE_DIR=/state
VOLUME ["/state"]

# no CMD by design: `coli daemon` in the foreground is the normal entrypoint,
# but you'll want `coli init`/`claude /login` interactively the first time
CMD ["coli", "daemon"]
