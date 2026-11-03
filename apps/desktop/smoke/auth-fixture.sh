#!/bin/sh
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-auth"
mkdir -p "$dir/project" "$dir/config/claude" "$dir/config/codex"
rm -f "$dir/config/claude/signed-in" "$dir/config/codex/signed-in"
cd "$dir/project"
git init -q -b main
git config user.name 'Provider auth smoke'
git config user.email auth@patchbay.invalid
git config commit.gpgsign false
printf 'fixture\n' > app.txt
printf '%s\n' '{"schemaVersion":4,"name":"Provider auth smoke","components":[],"links":[]}' > patchbay.json
git add .
git diff --cached --quiet || git commit -qm fixture
cat > "$dir/claude" <<'PYTHON'
#!/usr/bin/env python3
import json
import os
import pathlib
import sys

provider = pathlib.Path(sys.argv[0]).name
config = pathlib.Path(os.environ['CLAUDE_CONFIG_DIR' if provider == 'claude' else 'CODEX_HOME'])
marker = config / 'signed-in'
args = sys.argv[1:]
is_status = args[:2] == (['auth', 'status'] if provider == 'claude' else ['login', 'status'])
is_login = args[:2] == ['auth', 'login'] if provider == 'claude' else args[:1] == ['login'] and not is_status
if is_status or is_login:
    assert not os.environ.get('PATCHBAY_REPORT_DIR')
    assert not os.environ.get('PATCHBAY_CONTEXT_FILE')
    if is_status:
        if provider == 'claude':
            print(json.dumps({'loggedIn': marker.exists(), 'privateCanary': 'never-persist-auth-output'}))
        else:
            print('Logged in using ChatGPT' if marker.exists() else 'Not logged in')
        sys.exit(0 if marker.exists() else 1)
    print('fixture-login-ready', flush=True)
    if sys.stdin.readline().strip() == 'complete':
        marker.write_text('fixture-only')
        print('fixture-login-complete', flush=True)
    sys.exit(0)
print('fixture-agent-started', flush=True)
for line in sys.stdin:
    print('fixture-agent-received', flush=True)
PYTHON
cp "$dir/claude" "$dir/codex"
chmod +x "$dir/claude" "$dir/codex"
