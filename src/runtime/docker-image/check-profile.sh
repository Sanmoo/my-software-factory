#!/bin/sh
# Installs the packages of the container's settings.json and confirms the required ones are installed.
# Runs inside the sandbox after prepare-profile.sh and before the agent gets its prompt (ADR 0002). A failure
# stops the invocation, and the message on stderr is its reason.
#
# Usage: check-profile.sh [<required-package-source>...]
#
# `pi list` prints a package's installed path on the line below it; a package that is only listed in the
# settings has no path line. That is how "installed" is told apart from "declared".
set -eu
export PI_CODING_AGENT_DIR="${HOME}/.pi/agent"
SETTINGS="$PI_CODING_AGENT_DIR/settings.json"

if [ -f "$SETTINGS" ]; then
  sources=$(node -e '
    const settings = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const entry of settings.packages || []) console.log(typeof entry === "string" ? entry : entry.source);
  ' "$SETTINGS")
  for source in $sources; do
    # A package that is not required may fail to install without stopping the job; it is only reported.
    pi install "$source" >&2 || echo "profile-check: could not install package $source" >&2
  done
fi

listing=$(pi list 2>&1) || { echo "profile-check: pi list failed: $listing" >&2; exit 1; }
missing=""
for package in "$@"; do
  if ! printf '%s\n' "$listing" | awk -v p="$package" '
    found && /^[ \t]+\// { ok = 1 }
    { found = ($1 == p) }
    END { exit ok ? 0 : 1 }'; then
    missing="$missing $package"
  fi
done
if [ -n "$missing" ]; then
  echo "profile-check: required package not installed:$missing" >&2
  exit 1
fi
echo "profile-check: required packages installed: $*" >&2
