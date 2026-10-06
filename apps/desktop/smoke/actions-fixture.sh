#!/bin/sh
# Synthetic action components must not prune task metadata in the developer's real Git repo.
set -eu
base="${TMPDIR:-/tmp}/patchbay-smoke-actions"
rm -rf "$base"
mkdir -p "$base/project"
printf '%s\n' '{"name":"actions-fixture"}' > "$base/project/package.json"
