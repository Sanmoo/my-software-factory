#!/bin/sh
# Container evidence hook (onSandboxReady). Records container identity without secrets.
# The help phase leaves a marker in the container layer; the resume phase must not see it,
# proving the container was discarded and recreated.
set -eu
PHASE="$1"
MARKER="$HOME/.msf-layer-marker"
if [ "$PHASE" = "help" ]; then
  hostname > "$MARKER"
fi
if [ "$PHASE" = "resume" ]; then
  if [ -e "$MARKER" ]; then
    echo "container layer survived; expected a recreated container" >&2
    exit 1
  fi
fi
{
  echo "phase=$PHASE"
  echo "container=$(hostname)"
  echo "uid=$(id -u) gid=$(id -g)"
  echo "node=$(node -v)"
  echo "pi=$(pi --version)"
  echo "git=$(git --version)"
  if [ -n "${GH_TOKEN:-}" ]; then echo "gh_token_present=true"; else echo "gh_token_present=false"; fi
  if [ -f /.dockerenv ]; then echo "dockerenv=true"; else echo "dockerenv=false"; fi
} > "/msf-evidence/$PHASE.container.txt"
