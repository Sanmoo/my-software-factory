# Image of the MSF Docker runner (ticket #6, ADR 0004). Same Pi version as the spike image, reviewed
# for the runner. The base is Debian trixie rather than bookworm: the tools the operator declares in
# mise ship glibc-linked builds that need a newer glibc (rtk needs GLIBC_2.39; bookworm's is 2.36), and
# trixie's 2.41 satisfies them while keeping the Node major the image pins. Build with the host UID/GID
# so bind-mounted artifacts keep the operator's ownership:
#   docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) \
#     -t msf-docker-runner:local src/runtime/docker-image
FROM node:22-trixie-slim

ARG AGENT_UID=1000
ARG AGENT_GID=1000
ARG PI_VERSION=1.1.0
ARG MISE_VERSION=2026.8.10

# gh opens the pull request and reads CI from inside the container, authenticated by GH_TOKEN (the
# project account's token); git pushes through the credential helper of the job area. python3 runs the
# script of the gh-address-comments skill (triage of PR feedback). ripgrep and fd are the tools Pi
# probes for and downloads when they are missing: in the image, a steady start downloads nothing
# (fd-find is Debian's package name and installs `fdfind`; Pi probes for `fd`). jq is another probe.
# util-linux provides flock, which serializes the toolchain convergence (ADR 0004).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl python3 ripgrep fd-find jq util-linux \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh

# mise, pinned: the container converges the operator's declared tools with it (ADR 0004). Installed to
# a system path so the agent user can run it; the tools themselves go to the persistent per-profile
# data directory the runner mounts. curl was only needed here and for the GitHub CLI key: purge it.
RUN set -eux; \
  curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise sh; \
  mise --version; \
  apt-get purge -y curl && apt-get autoremove -y && apt-get clean && rm -rf /var/lib/apt/lists/*

# The agent user matches the host UID/GID. Every mount point the runner binds is created here,
# user-owned, and each level down to the leaf is named: install -d owns only the leaf it is given, and a
# root-owned ~/.local or ~/.pi/agent/npm would stop the convergence from writing into the bind.
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
    /home/agent/.pi/agent/npm \
    /home/agent/.config/mise \
    /home/agent/.local \
    /home/agent/.local/share \
    /home/agent/.local/share/mise; \
  chown -R "${AGENT_UID}:${AGENT_GID}" /home/agent

RUN npm install --global --no-fund --no-audit "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && pi --version

ENV HOME=/home/agent
# The declared shims come first on PATH, so the agent resolves the tools the convergence installed (rtk
# among them) and Pi stops warning; the mise data, cache and state live in the persistent directory the
# runner mounts; the declaration is read from the read-only profile snapshot. The two OTP adjustments are
# sandbox-only (ADR 0004): the image is Debian, mise publishes no precompiled OTP for it, so the sandbox
# asks for the precompiled Ubuntu build and refuses the source fallback instead of re-downloading on
# every start.
ENV MISE_DATA_DIR=/home/agent/.local/share/mise \
    MISE_CACHE_DIR=/home/agent/.local/share/mise/cache \
    MISE_STATE_DIR=/home/agent/.local/share/mise/state \
    MISE_CONFIG_DIR=/msf-profile/mise \
    MISE_ERLANG_PRECOMPILED_OS=ubuntu-22.04 \
    MISE_ERLANG_COMPILE=false \
    PATH=/home/agent/.local/share/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Sandcastle starts sandboxes with docker exec; the container must stay alive
# (same ENTRYPOINT as Sandcastle's own Pi template).
ENTRYPOINT ["sleep", "infinity"]
