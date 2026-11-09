#!/bin/sh
# Plan/Build UI checks use a local authenticated stand-in, never a user's provider account.
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-views"
rm -rf "$dir"
mkdir -p "$dir/project"
cp -R smoke/fixtures/project/. "$dir/project/"
git -C "$dir/project" init -q -b main
git -C "$dir/project" add .
git -C "$dir/project" -c user.name=Smoke -c user.email=smoke@patchbay.invalid -c commit.gpgsign=false commit -qm fixture
cat > "$dir/claude" <<'AGENT'
#!/bin/sh
if [ "${1:-}" = auth ] && [ "${2:-}" = status ]; then
  printf '{"loggedIn":true}\n'
  exit 0
fi
printf 'planner-root:%s\n' "$PWD"
cat "$PATCHBAY_CONTEXT_FILE"
while IFS= read -r line; do
  printf '%s\n' "$line"
  if [ "$line" = handoff ]; then
    printf '%s' '{"hook_event_name":"PreToolUse","session_id":"smoke-native-plan","tool_name":"ExitPlanMode","tool_input":{"plan":"# Smoke handoff\nImplement the saved plan."}}' | "${PATCHBAY_CLI%/*}/patchbay-sessiond" report-status claude
  fi
done
AGENT
chmod +x "$dir/claude"
