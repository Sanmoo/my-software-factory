#!/bin/sh
# Confirms the required packages of the profile are installed in the converged package tree (ADR 0004).
# Runs inside the sandbox after the convergence and before the agent gets its prompt: converge-profile.sh
# installed the packages from the operator's lock into the persistent tree, and nothing is installed here.
# A steady start therefore does no network work and prints nothing. A failure stops the invocation, and
# the message on stderr is its reason.
#
# `pi list` prints a package's installed path on the line below it; a package that is only listed in the
# settings has no path line. That is how "installed" is told apart from "declared".
#
# Usage: check-profile.sh [<required-package-source>...]
set -eu
export PI_CODING_AGENT_DIR="${HOME}/.pi/agent"
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
