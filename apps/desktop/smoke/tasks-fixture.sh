#!/bin/sh
# A scratch repo for smoke/tasks.js, which creates and removes worktrees beside it.
set -e
dir="${TMPDIR:-/tmp}/patchbay-smoke-tasks"
rm -rf "$dir"
mkdir -p "$dir/shop/apps/web"
cd "$dir/shop"
echo web > apps/web/index.ts
echo readme > README.md
git init -q -b main
git -c user.name=smoke -c user.email=smoke@example.com -c commit.gpgsign=false add .
git -c user.name=smoke -c user.email=smoke@example.com -c commit.gpgsign=false commit -qm init
