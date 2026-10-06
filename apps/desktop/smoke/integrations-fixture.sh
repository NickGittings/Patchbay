#!/bin/sh
set -e
# Only this smoke's scratch directory; it never opens the user's projects.
dir="${TMPDIR:-/tmp}/patchbay-smoke-integrations"
rm -rf "$dir"
mkdir -p "$dir/shop/web folder"
printf 'services: {}\n' > "$dir/shop/web folder/compose.yml"
printf 'main\n' > "$dir/shop/web folder/scope.txt"
cd "$dir/shop"
git init -q -b main
git add .
git -c user.name=smoke -c user.email=smoke@example.com -c commit.gpgsign=false commit -qm init
