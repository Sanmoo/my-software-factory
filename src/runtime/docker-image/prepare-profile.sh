#!/bin/sh
# Builds the writable, container-local Pi agent directory from the runtime profile snapshot (ADR 0002).
# Runs inside the sandbox before the agent gets its prompt. The snapshot is mounted read-only and holds
# real files only: the host resolved the links and applied the exclusions, so nothing here follows a link
# or filters a package.
#
# Two entries of the snapshot are not copied: `npm` is the persistent package tree that
# converge-profile.sh installs from the lock, and `mise` is the operator's declaration, read from the
# snapshot itself (ADR 0004). Copying them would clobber the converged tree or land in the wrong place.
#
# Usage: prepare-profile.sh <snapshot-mount>
set -eu
SNAPSHOT="$1"
DST="${HOME}/.pi/agent"
mkdir -p "$DST"
cd "$SNAPSHOT"
for entry in * .[!.]*; do
  [ -e "$entry" ] || continue
  case "$entry" in
    npm|mise) continue ;;
  esac
  cp -R "$entry" "$DST/"
done
if [ -f "$DST/auth.json" ]; then chmod 600 "$DST/auth.json"; fi
