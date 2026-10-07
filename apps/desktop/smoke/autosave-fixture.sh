#!/bin/sh
set -eu
base="${TMPDIR:-/tmp}/patchbay-smoke-autosave"
rm -rf "$base"
mkdir -p "$base/one/web" "$base/two/web"
printf '%s\n' '{"name":"web"}' > "$base/one/web/package.json"
printf '%s\n' '{"name":"web"}' > "$base/two/web/package.json"
