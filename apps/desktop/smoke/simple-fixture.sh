#!/bin/sh
# Simple uses local stand-in agents and disposable worktrees only.
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-simple"
rm -rf "$dir"
mkdir -p "$dir/project/src"
cd "$dir/project"
git init -q -b main
git config user.name 'Simple smoke'
git config user.email simple@patchbay.invalid
git config commit.gpgsign false
printf 'base\n' > src/app.txt
printf '%s\n' '{"schemaVersion":4,"name":"Simple smoke","components":[{"id":"app","name":"App","path":"src","kind":"app","notes":"","position":{"x":0,"y":0},"terminals":[]}],"links":[]}' > patchbay.json
git add .
git commit -qm base
git worktree add -q -b feature "$dir/feature"
cat > "$dir/agent.py" <<'PYTHON'
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

journal = pathlib.Path(os.environ['PATCHBAY_REPORT_DIR'])
body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
conversation = str(uuid.uuid4())
turn = str(uuid.uuid4())
sequence = 0

def report(event, **extra):
    global sequence
    sequence += 1
    # Journal records are normalized; retain the provider's raw input for the fixture too.
    if 'last_assistant_message' in extra:
        extra['reply'] = extra['last_assistant_message']
    data = dict(session=os.environ['PATCHBAY_REPORT_SESSION'], generation=int(os.environ['PATCHBAY_REPORT_GENERATION']), provider=os.environ['PATCHBAY_REPORT_PROVIDER'], sequence=sequence, atMs=int(time.time()*1000), event=event, conversation=conversation, turn=turn, prompt=None, message=None, source=None)
    data.update(extra)
    temp = journal / 'pending'
    temp.write_text(json.dumps(data))
    temp.replace(journal / ('%020d.json' % sequence))

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def work():
    report('UserPromptSubmit')
    report('PreToolUse', tool='Edit', target='src/app.txt', fileTarget=True)
    component = os.environ.get('PATCHBAY_COMPONENT')
    time.sleep(4 if component == 'plan' else 1.5)
    if component == 'plan':
        pathlib.Path(os.environ['PATCHBAY_PLAN_FILE']).write_text('# Simple fixture plan\n\nUpdate the app.\n')
        reply = 'I planned the **fixture feature**. The plan is ready.'
    elif component == '@merge':
        head = next(line.split(': ', 1)[1] for line in body.splitlines() if line.startswith('Source HEAD: '))
        git('merge', '--no-commit', '--no-ff', head)
        git('commit', '-qm', 'Merge simple fixture')
        reply = 'Merged the fixture into main.'
    elif os.environ.get('PATCHBAY_REVIEW_FILE'):
        fixed = pathlib.Path('src/app.txt').read_text() == 'simple fixed\n'
        path = pathlib.Path(os.environ['PATCHBAY_REVIEW_FILE'])
        path.write_text('Verdict: clean\nCounts: {"critical":0,"high":0,"medium":0,"low":0}\nNo issues.\n' if fixed else 'Verdict: issues\nCounts: {"critical":0,"high":1,"medium":0,"low":0}\n[high] src/app.txt:1: Fix the fixture.\n')
        reply = 'The review found one issue.' if not fixed else 'The review is clean.'
    else:
        fixing = 'Fix the fixture' in body
        pathlib.Path('src/app.txt').write_text('simple fixed\n' if fixing else 'simple changed\n')
        git('add', 'src/app.txt')
        git('commit', '-qm', 'Fix fixture' if fixing else 'Build fixture')
        reply = 'Fixed the review finding.' if fixing else 'Built the fixture feature.'
    report('Stop', last_assistant_message=reply)
    print('simple-work-finished', flush=True)

report('SessionStart')
print('simple-ready', flush=True)
if os.environ.get('PATCHBAY_COMPONENT') != 'plan':
    work()
for line in sys.stdin:
    pathlib.Path(__file__).with_name('received.json').write_text(json.dumps(line))
    print('simple-received:' + line.strip(), flush=True)
    line = line.replace('\x1b[200~', '').replace('\x1b[201~', '')
    turn = str(uuid.uuid4())
    if line.strip() == 'smoke-changes':
        report('UserPromptSubmit')
        pathlib.Path('src/app.txt').write_text('uncommitted fixture change\n')
        pathlib.Path('src/another.txt').write_text('another change\n')
        pathlib.Path('src/third.txt').write_text('third change\n')
        report('PreToolUse', tool='Edit', target='src/third.txt', fileTarget=True)
        report('Stop', last_assistant_message='Edited three fixture files.')
        continue
    if line.strip() == 'smoke-clean':
        git('restore', 'src/app.txt')
        pathlib.Path('src/another.txt').unlink()
        pathlib.Path('src/third.txt').unlink()
        continue
    if line.strip().startswith('smoke-exit-'):
        sys.exit(int(line.strip().removeprefix('smoke-exit-')))
    if line.strip() == 'smoke-input':
        report('UserPromptSubmit')
        report('Notification', message='Allow fixture tool?')
        continue
    work()
PYTHON
cat > "$dir/claude" <<'SHELL'
#!/bin/sh
set -eu
# A Claude agent without hooks: it never reports a ready prompt.
printf 'unhooked-ready\n'
sleep 120
SHELL
chmod +x "$dir/claude"
