#!/bin/sh
# Builds the writable, container-local Pi agent directory from the runtime profile snapshot (ADR 0002).
# Runs inside the sandbox (onSandboxReady). The snapshot is mounted read-only and holds real files only:
# the host resolved the links and applied the exclusions, so nothing here follows a link or filters a package.
#
# Usage: prepare-profile.sh <snapshot-mount>
set -eu
SNAPSHOT="$1"
DST="${HOME}/.pi/agent"
mkdir -p "$DST"
cp -R "$SNAPSHOT/." "$DST/"
if [ -f "$DST/auth.json" ]; then chmod 600 "$DST/auth.json"; fi
