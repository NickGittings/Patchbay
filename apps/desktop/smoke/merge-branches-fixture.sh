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
  git -C "$dir/$name" branch unused
  git -C "$dir/$name" checkout -qb feature
  printf 'feature\n' > "$dir/$name/shared.txt"
  git -C "$dir/$name" commit -qam feature
done
cat > "$dir/lead.py" <<'PY'
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import tty
import uuid

tty.setcbreak(sys.stdin.fileno())

journal = pathlib.Path(os.environ['PATCHBAY_REPORT_DIR'])
conversation = str(uuid.uuid4())
turn = str(uuid.uuid4())
sequence = 0

def report(event, **extra):
    global sequence
    sequence += 1
    data = dict(session=os.environ['PATCHBAY_REPORT_SESSION'],
                generation=int(os.environ['PATCHBAY_REPORT_GENERATION']),
                provider=os.environ['PATCHBAY_REPORT_PROVIDER'], sequence=sequence,
                atMs=int(time.time()*1000), event=event, conversation=conversation, turn=turn)
    data.update(extra)
    temp = journal / 'pending'
    temp.write_text(json.dumps(data))
    temp.replace(journal / ('%020d.json' % sequence))

report('SessionStart')
report('UserPromptSubmit')
time.sleep(.4)
report('Stop', reply='Ready')
buffer = ''
for line in sys.stdin:
    buffer += line
    if '\x1b[200~' in buffer and '\x1b[201~' not in buffer:
        continue
    prompt = buffer.replace('\x1b[200~', '').replace('\x1b[201~', '').strip()
    buffer = ''
    if not prompt:
        continue
    turn = str(uuid.uuid4())
    report('UserPromptSubmit')
    if prompt == 'Merge the fixture branch':
        with tempfile.NamedTemporaryFile(mode='w') as settings:
            json.dump({}, settings)
            settings.flush()
            subprocess.run([os.environ['PATCHBAY_CLI'], 'agent', 'team-request', '--id', 'fixture-merge',
                            '--action', 'startMerge', '--file', settings.name], check=True)
    report('Stop', reply='Ready.')
PY

cat > "$dir/codex" <<WRAPPER
#!/bin/sh
if [ "\${1:-}" = login ] && [ "\${2:-}" = status ]; then
  printf 'Logged in using ChatGPT\n'
  exit 0
fi
exec python3 '$dir/lead.py' "\$@"
WRAPPER
chmod +x "$dir/codex"
