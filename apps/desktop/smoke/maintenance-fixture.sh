#!/bin/sh
set -eu
base="${TMPDIR:-/tmp}/patchbay-smoke-maintenance"
rm -rf "$base"
mkdir -p "$base/project/web" "$base/project/api" "$base/project/new" "$base/project/moved-new"
cat > "$base/project/web/package.json" <<'JSON'
{"name":"web","dependencies":{"api":"*","new":"*"}}
JSON
printf '%s\n' '{"name":"api"}' > "$base/project/api/package.json"
printf '%s\n' '{"name":"new"}' > "$base/project/new/package.json"
printf '%s\n' '{"name":"moved","dependencies":{"api":"*"}}' > "$base/project/moved-new/package.json"
printf '%s\n' 'file, not a component folder' > "$base/project/file"
cat > "$base/project/patchbay.json" <<'JSON'
{
  "schemaVersion":3,"name":"Maintenance fixture",
  "components":[
    {"id":"web","name":"Custom web","path":"web","kind":"frontend","notes":"Preserve user notes","position":{"x":92,"y":112},"terminals":[{"id":"shell","name":"Shell","kind":"shell","command":"cat"}],"detection":{"detector":"builtin","packageIdentity":"npm:web"}},
    {"id":"api","name":"API","path":"api","terminals":[{"id":"shell","name":"Shell","kind":"shell","command":"cat"}],"detection":{"detector":"builtin","packageIdentity":"npm:api"}},
    {"id":"old","name":"Renamed moved package","path":"old","notes":"Keep this component ID","detection":{"detector":"builtin","packageIdentity":"npm:moved"}},
    {"id":"mystery","name":"Legacy missing","path":"missing"},
    {"id":"unreadable","name":"Non-directory","path":"file"},
    {"id":"locked","name":"Denied folder","path":"../not-granted"}
  ],
  "links":[
    {"id":"manual","source":"web","target":"api","label":"User label"},
    {"id":"stale","source":"api","target":"web","detection":{"detector":"builtin"}},
    {"id":"unavailable","source":"web","target":"api","label":"Unavailable detector preserves this","detection":{"detector":"extension:disabled:links"}}
  ],
  "groups":[{"id":"dev","name":"Development","componentIds":["web","old","mystery"]}]
}
JSON
git -C "$base/project" init -q -b main
git -C "$base/project" add .
git -C "$base/project" -c user.name=Smoke -c user.email=smoke@patchbay.test -c commit.gpgsign=false commit -qm fixture

mkdir -p "$base/second/api"
printf '%s\n' '{"name":"Second API"}' > "$base/second/api/package.json"
cat > "$base/second/patchbay.json" <<'JSON'
{"schemaVersion":3,"name":"Other workspace","components":[{"id":"api","name":"Second API","path":"api"}]}
JSON
