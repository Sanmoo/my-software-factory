# The factory's worker image (ticket 17, issue #159). Adapted from the v1
# runner image: Debian trixie base, the agent user matching the host UID/GID so
# bind-mounted artifacts keep the operator's ownership, and the same ENTRYPOINT
# Sandcastle's own Pi template uses — the container stays alive and Sandcastle
# enters with `docker exec`. Build with the host UID/GID:
#   npm run build:image
#
# The agent environment is provisioned HERE, from the factory's committed
# declaration (agent-resources.json): Pi at its exact version, the selected
# upstream skills at an immutable revision, the delegation extension at its
# exact version with operating guidance, and the reviewer agents. The worker
# starts with that set already present — no personal Pi profile, no startup
# install, no discovery from the host or the target project.
FROM node:22-trixie-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
# Passed from agent-resources.json by `npm run build:image` — never defaulted
# here, so the declaration is the only source of what Pi gets installed.
ARG PI_PACKAGE
ARG PI_VERSION

# git pushes the work branch and fetches the pinned skill revision during the
# build; gh opens the PR, reads the issue and comments, authenticated by
# GH_TOKEN (the worker account's token). ripgrep and fd are the tools Pi probes
# for and downloads when they are missing: in the image, a steady start
# downloads nothing (fd-find is Debian's package name and installs `fdfind`;
# Pi probes for `fd`). jq is another probe. curl is only needed here, for the
# GitHub CLI key, and is purged after.
#
# The docker CLI is the CLIENT only: the runtime binds the host's daemon socket
# into the worker container (ADR 0003), so a worker builds the worker image and
# runs the repo's real Docker tests instead of self-reporting blocked for a
# missing Docker. buildx is what `docker build` drives on a modern daemon (the
# legacy builder is gone); the client negotiates the API with the host's server,
# so its Debian version need not match the host's. No daemon package here: the
# worker must never start a second Docker of its own.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg python3 ripgrep fd-find jq docker-cli docker-buildx \
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
# is created here, user-owned, so the binds land writable.
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
    /home/agent/.local/share/mise; \
  printf 'export PATH="/home/agent/.local/share/mise/shims:$PATH"\n' >> /home/agent/.profile; \
  chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

# The worker publishes the work branch with `git push` over HTTPS (the
# prompt's step 2); `gh auth git-credential` is the bridge from git to the
# token. GH_TOKEN — injected into the container at launch, never baked here —
# is what that helper reads, but git only calls it when a credential.helper
# is configured: without this section `git push` dies with "could not read
# Username for 'https://github.com'" and the round self-reports blocked for a
# factory provisioning gap. The section is configuration, not a secret — the
# empty helper first resets any ambient helper list, the same shape
# `gh auth setup-git` writes. The file stays the agent's own: Sandcastle's
# `git config --global user.name/email` setup edits it in place at launch.
RUN printf '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n[credential "https://gist.github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n' > /home/agent/.gitconfig \
 && chown "${AGENT_UID}:${AGENT_GID}" /home/agent/.gitconfig

# Pi at the exact declared version. The provisioning step below verifies the
# installed version against the declaration and refuses a mismatch.
RUN npm install --global --no-fund --no-audit "${PI_PACKAGE}@${PI_VERSION}" \
 && pi --version

# The factory-owned agent resources. The script stages everything, validates
# every declared skill/reference/version/digest, and swaps the destination in
# only after all checks pass — an invalid or unavailable source fails the
# build. The inventory records what THIS image actually contains, so the
# runtime can compare it with the declaration of the MSF checkout.
COPY scripts/agent-resources.mjs /opt/msf/scripts/agent-resources.mjs
COPY docker/provision-agent.mjs /opt/msf/docker/provision-agent.mjs
COPY agent-resources.json /opt/msf/agent-resources.json
COPY agents /opt/msf/agents
RUN node /opt/msf/docker/provision-agent.mjs \
      --declaration /opt/msf/agent-resources.json \
      --dest /home/agent/.pi/agent \
      --inventory /opt/msf/agent-inventory.json \
 && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent/.pi/agent

ENV HOME=/home/agent

# The toolchain convergence layer (ticket 18): the runtime binds the host's
# <workspace>/toolchains/mise read-write OVER /home/agent/.local/share/mise,
# so the shims below appear after the session's first `mise install go` (etc.)
# and persist across launches — later launches reuse, nothing pre-installed.
ENV PATH="/home/agent/.local/share/mise/shims:${PATH}"

# The continuity guardrail (issue 119): the compiled, factory-owned extension
# the runtime loads with --extension. It journals every external effect before
# the tool runs and blocks a repeat when a recovered session tries one that
# already happened. Staged from dist/ by `npm run build:image`, so the image
# carries exactly the code this factory version pins; the launch preflight
# refuses an image without it. Read-only to the worker user.
COPY docker/guardrail /opt/msf/
RUN chmod -R a+rX /opt/msf

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle starts sandboxes with docker exec; the container must stay alive
# (same ENTRYPOINT as Sandcastle's own Pi template).
ENTRYPOINT ["sleep", "infinity"]
