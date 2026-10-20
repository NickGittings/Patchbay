#!/bin/sh
set -eu
base="${TMPDIR:-/tmp}/patchbay-smoke-dependencies"
rm -rf "$base"
# `jobs` reuses the backend's requirements by path; `web` calls `api` only at runtime.
mkdir -p "$base/project/web" "$base/project/api" "$base/project/jobs"
printf '%s\n' '{"name":"web","dependencies":{"react":"19"}}' > "$base/project/web/package.json"
printf '%s\n' 'django' > "$base/project/api/requirements.txt"
printf '%s\n' '-r ../api/requirements.txt' > "$base/project/jobs/requirements.txt"
git -C "$base/project" init -q -b main
# Two components and nothing linking them.
mkdir -p "$base/second/web" "$base/second/api"
printf '%s\n' '{"name":"web"}' > "$base/second/web/package.json"
printf '%s\n' 'module example.com/api' > "$base/second/api/go.mod"
