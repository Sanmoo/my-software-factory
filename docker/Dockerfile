# The factory's worker image (ticket 17). Adapted from the v1 runner image
# (src/runtime/docker-image/Dockerfile, backup-old-factory history): Debian
# trixie base, the agent user matching the host UID/GID so bind-mounted
# artifacts keep the operator's ownership, and the same ENTRYPOINT Sandcastle's
# own Pi template uses — the container stays alive and Sandcastle enters with
# `docker exec`. Build with the host UID/GID:
#   npm run build:image
FROM node:22-trixie-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
ARG PI_VERSION=1.3.0

# git pushes the work branch; gh opens the PR, reads the issue and comments,
# authenticated by GH_TOKEN (the worker account's token). ripgrep and fd are
# the tools Pi probes for and downloads when they are missing: in the image, a
# steady start downloads nothing (fd-find is Debian's package name and installs
# `fdfind`; Pi probes for `fd`). jq is another probe. curl is only needed here,
# for the GitHub CLI key, and is purged after.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg python3 ripgrep fd-find jq \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh mise \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && apt-get clean && rm -rf /var/lib/apt/lists/*

# The agent user matches the host UID/GID. Every mount point the runtime binds
# is created here, user-owned, so the binds and the profile copy land writable.
RUN set -eux; \
  if getent passwd node >/dev/null; then userdel --remove node || true; fi; \
  if getent group node >/dev/null; then groupdel node || true; fi; \
  if getent group "${AGENT_GID}" >/dev/null; then \
    groupmod --new-name agent "$(getent group "${AGENT_GID}" | cut -d: -f1)"; \
  else \
    groupadd --gid "${AGENT_GID}" agent; \
  fi; \
  useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --home-dir /home/agent --create-home --shell /bin/bash agent; \
  install -d -o agent -g agent \
    /home/agent/.pi/agent \
    /home/agent/.config \
    /home/agent/.local/share/mise \
    /home/agent/.pi/agent/npm; \
  printf 'export PATH="/home/agent/.local/share/mise/shims:$PATH"\n' >> /home/agent/.profile; \
  chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

RUN npm install --global --no-fund --no-audit "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

ENV HOME=/home/agent

# The toolchain convergence layer (ticket 18): the runtime binds the host's
# <workspace>/toolchains/mise read-write OVER /home/agent/.local/share/mise,
# so the shims below appear after the session's first `mise install go` (etc.)
# and persist across launches — later launches reuse, nothing pre-installed.
ENV PATH="/home/agent/.local/share/mise/shims:${PATH}"

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle starts sandboxes with docker exec; the container must stay alive
# (same ENTRYPOINT as Sandcastle's own Pi template).
ENTRYPOINT ["sleep", "infinity"]
