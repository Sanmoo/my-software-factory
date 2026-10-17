#!/bin/sh
# Converges the profile's toolchain inside the sandbox, once, from what the host resolved (ADR 0004):
# the Pi packages from the operator's lock and the mise tools from the operator's declaration. Both live
# in persistent directories bind-mounted per profile, so the next invocation installs nothing and needs
# no network. The convergence is strict: a required item that cannot be converged stops the invocation
# with its reason before the agent gets its prompt.
#
# The recipe is the one the safe-pi wrapper proved (dotfiles ADR 0002/0009): probe first, install under
# flock, stamp written only after success and removed before it, and the sandbox-only OTP adjustments.
# No host binary is mounted: the tools are installed here, for this image.
#
# Usage: converge-profile.sh <snapshot-mount> [<required-tool>...]
set -eu

SNAPSHOT="${1:?converge-profile.sh requires the snapshot mount}"
shift

HOST_NPM="$SNAPSHOT/npm"
NPM_DIR="${HOME}/.pi/agent/npm"
NPM_STAMP="$NPM_DIR/.msf-stamp"
NPM_LOCK="$NPM_DIR/.msf-converge.lock"

# The declared tools go first on PATH, so a tool resolved here is the converged one. The image's own PATH
# is kept before the shims: the package tree is installed with the image's npm and hashed with the image's
# Node ABI, and a declared `node` shim must never shadow either of them.
MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
MISE_SHIMS="$MISE_DATA_DIR/shims"
IMAGE_PATH="$PATH"
case "$IMAGE_PATH" in
  "$MISE_SHIMS:"*) IMAGE_PATH="${IMAGE_PATH#"$MISE_SHIMS:"}" ;;
esac
export MISE_DATA_DIR
# The cache and the state belong in the persistent directory too: the state is what lets an interrupted
# install be recognised on the next start.
export MISE_CACHE_DIR="${MISE_CACHE_DIR:-$MISE_DATA_DIR/cache}"
export MISE_STATE_DIR="${MISE_STATE_DIR:-$MISE_DATA_DIR/state}"
# The operator's declaration is carried by the snapshot and read from there (read-only). The image also
# exports this default, so the agent's own `mise` reads the same declaration.
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$SNAPSHOT/mise}"
# Sandbox-only OTP adjustments: the image is Debian and mise publishes no precompiled OTP for it, so the
# declared OTP would be built from source on every start. The sandbox asks for the precompiled Ubuntu
# build the image's glibc satisfies and refuses the source fallback, so a pin without a precompiled build
# fails fast and loud instead. On the host, refusing the fallback would break the next OTP install.
export MISE_ERLANG_PRECOMPILED_OS="${MISE_ERLANG_PRECOMPILED_OS:-ubuntu-22.04}"
export MISE_ERLANG_COMPILE="${MISE_ERLANG_COMPILE:-false}"
PATH="$MISE_SHIMS:$PATH"
export PATH

# --- The Pi packages, from the operator's lock ---------------------------------
# The key is the hash of the declaration and its lock plus the image's Node ABI, so the native bindings
# match the platform the tree is installed for and an image with another Node major reinstalls.
npm_key() {
  node -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const hash = crypto.createHash("sha256");
    hash.update("abi=" + process.versions.modules + "\0");
    for (const file of process.argv.slice(1)) hash.update(fs.readFileSync(file)).update("\0");
    process.stdout.write(hash.digest("hex"));
  ' "$HOST_NPM/package.json" "$HOST_NPM/package-lock.json"
}

npm_tree_converged() {
  [ -f "$NPM_STAMP" ] && [ "$(cat "$NPM_STAMP" 2>/dev/null || true)" = "$1" ]
}

converge_npm() {
  # No host lock means nothing is declared, so there is nothing to converge.
  [ -f "$HOST_NPM/package.json" ] && [ -f "$HOST_NPM/package-lock.json" ] || return 0
  mkdir -p "$NPM_DIR" || return 1
  key="$(PATH="$IMAGE_PATH" npm_key)" || return 1
  npm_tree_converged "$key" && return 0
  (
    # The tree may be converged by several invocations at once; the lock serializes them, so the second
    # one waits and then finds the tree converged.
    exec 9>"$NPM_LOCK"
    if ! flock -n 9; then
      echo "profile-converge: waiting for another invocation to finish installing the Pi packages" >&2
      flock 9
    fi
    npm_tree_converged "$key" && exit 0
    # The stamp leaves before the install and returns only after it succeeds: an interrupted or failed
    # install is redone on the next start instead of looking complete.
    rm -f "$NPM_STAMP"
    echo "profile-converge: installing the Pi packages from the operator's lock" >&2
    cp "$HOST_NPM/package.json" "$HOST_NPM/package-lock.json" "$NPM_DIR/" || exit 1
    cd "$NPM_DIR" || exit 1
    # The image's own node and npm: the declared shims must not shadow them. --legacy-peer-deps is the
    # flag Pi's own installs use, so the lock is honoured.
    PATH="$IMAGE_PATH" npm ci --legacy-peer-deps --no-fund --no-audit >&2 || exit 1
    printf '%s' "$key" >"$NPM_STAMP"
  )
}

# --- The mise tools, from the operator's declaration ----------------------------
converge_mise() {
  mkdir -p "$MISE_DATA_DIR" || return 1
  (
    exec 9>"$MISE_DATA_DIR/.msf-converge.lock"
    if ! flock -n 9; then
      echo "profile-converge: waiting for another invocation to finish converging the toolchain" >&2
      flock 9
    fi
    # The declaration applies from home; the probe is silent and fast when everything is installed, so a
    # steady start prints nothing and installs nothing.
    cd "$HOME" || exit 1
    mise install --dry-run-code >/dev/null 2>&1 && exit 0
    echo "profile-converge: installing the tools declared in the operator's mise configuration" >&2
    mise install --yes
  )
}

status=0
if ! (PATH="$IMAGE_PATH" converge_npm); then
  echo "profile-converge: the Pi packages could not be converged from the operator's lock" >&2
  status=1
fi
if ! converge_mise; then
  echo "profile-converge: the mise toolchain could not be converged from the operator's declaration" >&2
  status=1
fi
[ "$status" -eq 0 ] || exit 1

# --- The required tools must answer on PATH ------------------------------------
missing=""
for tool in "$@"; do
  resolved=$(command -v "$tool" 2>/dev/null || true)
  if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then missing="$missing $tool"; fi
done
if [ -n "$missing" ]; then
  echo "profile-converge: required tool not found on PATH:$missing" >&2
  exit 1
fi
