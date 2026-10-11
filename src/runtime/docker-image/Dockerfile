# Image of the MSF Docker runner (ticket #6, R06/CA08). Same base and Pi version as the
# spike image, reviewed for the runner. Build with the host UID/GID so bind-mounted
# artifacts keep the operator's ownership:
#   docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) \
#     -t msf-docker-runner:local src/runtime/docker-image
FROM node:22-bookworm-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
ARG PI_VERSION=1.1.0

# gh opens the pull request and reads CI from inside the container, authenticated by GH_TOKEN
# (the project account's token); git pushes through the credential helper of the job area.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates curl \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh \
 && apt-get purge -y curl && apt-get autoremove -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  if getent passwd node >/dev/null; then userdel --remove node || true; fi; \
  if getent group node >/dev/null; then groupdel node || true; fi; \
  if getent group "${AGENT_GID}" >/dev/null; then \
    groupmod --new-name agent "$(getent group "${AGENT_GID}" | cut -d: -f1)"; \
  else \
    groupadd --gid "${AGENT_GID}" agent; \
  fi; \
  useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" --home-dir /home/agent --create-home --shell /bin/bash agent; \
  mkdir -p /home/agent/.pi/agent; \
  chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

RUN npm install --global --no-fund --no-audit "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

ENV HOME=/home/agent
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle starts sandboxes with docker exec; the container must stay alive
# (same ENTRYPOINT as Sandcastle's own Pi template).
ENTRYPOINT ["sleep", "infinity"]
