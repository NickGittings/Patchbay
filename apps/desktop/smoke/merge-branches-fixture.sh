#!/bin/sh
# Share deterministic review/merge agents, using primary feature checkouts without worktrees.
set -eu
sh "$(dirname "$0")/merge-fixture.sh"
dir="${TMPDIR:-/tmp}/patchbay-smoke-merge"
for name in chat-primary review-primary; do
  mkdir -p "$dir/$name"
  git -C "$dir/$name" init -q -b main
  git -C "$dir/$name" config user.name 'Merge smoke'
  git -C "$dir/$name" config user.email merge@patchbay.invalid
  git -C "$dir/$name" config commit.gpgsign false
  printf 'base\n' > "$dir/$name/shared.txt"
  printf '%s\n' '{"schemaVersion":4,"name":"Primary feature merge","components":[],"links":[]}' > "$dir/$name/patchbay.json"
  git -C "$dir/$name" add .
  git -C "$dir/$name" commit -qm base
  git -C "$dir/$name" checkout -qb feature
  printf 'feature\n' > "$dir/$name/shared.txt"
  git -C "$dir/$name" commit -qam feature
done
