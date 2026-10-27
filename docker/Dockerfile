# The factory's worker image: Debian trixie, an agent user matching the host
# UID/GID (bind-mounted artifacts keep the operator's ownership), kept alive
# for `docker exec`. Build with `npm run build:image`.
#
# The agent environment is provisioned HERE from agent-resources.yaml: Pi at
# its exact version, the selected skills at an immutable revision, the
# delegation extension with its operating guidance, the reviewer agents. The
# worker starts with that set — no personal Pi profile, no startup install, no
# discovery from the host or the target project.
FROM node:22-trixie-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
# Passed by `npm run build:image` from the declaration, never defaulted here:
# one source decides which Pi the image installs.
ARG PI_PACKAGE
ARG PI_VERSION

# git pushes the work branch and fetches the pinned skills revision during the
# build; gh reads the issue and opens the PR, authenticated by GH_TOKEN.
# ripgrep, fd and jq are what Pi probes for and would otherwise download at
# start (fd-find installs `fdfind`). The docker CLI is the client only: the
# runtime binds the host's daemon socket (ADR 0003), so the worker never starts
# a daemon. curl only fetches the apt keys and is purged.
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

# The agent user matches the host UID/GID; every mount point the runtime binds
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

# git calls `gh auth git-credential` only when a credential.helper is
# configured; without it `git push` asks for a username. GH_TOKEN arrives at
# launch, never from here.
RUN printf '[credential "https://github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n[credential "https://gist.github.com"]\n\thelper =\n\thelper = !gh auth git-credential\n' > /home/agent/.gitconfig \
 && chown "${AGENT_UID}:${AGENT_GID}" /home/agent/.gitconfig

# Pi at the exact declared version; provisioning verifies it and refuses a
# mismatch.
RUN npm install --global --no-fund --no-audit "${PI_PACKAGE}@${PI_VERSION}" \
 && pi --version

# The declared resources: the provisioner stages, validates every skill,
# reference, version, licence and dependency, and swaps the destination in only
# when every check passed. The inventory it writes records what this image
# holds, for the launch to compare with the checkout's declaration.
# `agent-resources.json` is the canonical form `npm run build:image` generated
# from agent-resources.yaml.
COPY scripts/agent-resources.mjs /opt/msf/scripts/agent-resources.mjs
COPY docker/provision-agent.mjs /opt/msf/docker/provision-agent.mjs
COPY docker/agent-resources.json /opt/msf/agent-resources.json
COPY agents /opt/msf/agents
RUN node /opt/msf/docker/provision-agent.mjs \
      --declaration /opt/msf/agent-resources.json \
      --dest /home/agent/.pi/agent \
      --inventory /opt/msf/agent-inventory.json \
 && chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent/.pi/agent

ENV HOME=/home/agent

# The runtime binds <workspace>/toolchains/mise over this directory, so tools
# installed through mise persist across launches; nothing is pre-installed.
ENV PATH="/home/agent/.local/share/mise/shims:${PATH}"

# The continuity guardrail: factory code the runtime loads as an extension. It
# journals every external effect before the tool runs and blocks a repeat on a
# recovered session. Staged from dist/ by `npm run build:image`; the launch
# refuses an image without it. Read-only to the worker.
COPY docker/guardrail /opt/msf/
# The worker's Jira client: the tool that asks the factory for Jira reads and
# authorized publications. It holds no credential — the factory performs every
# API call.
COPY docker/jira-client /opt/msf/
RUN chmod -R a+rX /opt/msf

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle starts sandboxes with docker exec; the container must stay alive.
ENTRYPOINT ["sleep", "infinity"]
