#!/bin/sh
# Builds a writable, container-local Pi agent directory from read-only mounts of the
# operator's personal profile. Runs inside the sandbox (onSandboxReady). Never writes
# to the host profile. Symlinks whose targets are not mounted are skipped and logged,
# so work-account resources outside the personal profile are not loaded.
#
# Usage: prepare-profile.sh <host-profile-mount> <agents-mount> <dotfiles-mount>
set -eu
PROFILE_SRC="$1"
DST="${HOME}/.pi/agent"
mkdir -p "$DST" "$DST/skills" "$DST/extensions" "$DST/agents"

copy_entry() {
  # $1 = source path, $2 = destination directory
  if [ -e "$1" ]; then
    cp -RL "$1" "$2/"
  else
    echo "profile-prepare: skipped broken or unmounted link: $1" >&2
  fi
}

for entry in settings.json auth.json keybindings.json AGENTS.md models-store.json; do
  copy_entry "$PROFILE_SRC/$entry" "$DST"
done
chmod 600 "$DST/auth.json"

for dir in agents extensions skills; do
  for item in $(ls -A "$PROFILE_SRC/$dir" 2>/dev/null); do
    copy_entry "$PROFILE_SRC/$dir/$item" "$DST/$dir"
  done
done
