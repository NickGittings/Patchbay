#!/bin/sh
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-auto"
rm -rf "$dir"
mkdir -p "$dir/project"
cd "$dir/project"
git init -q -b main
git config user.name 'Auto smoke'
git config user.email auto@patchbay.invalid
git config commit.gpgsign false
printf 'base\n' > shared.txt
printf '%s\n' '{"schemaVersion":4,"name":"Auto smoke","components":[{"id":"root","name":"Root","path":".","kind":"app","notes":"","position":{"x":0,"y":0},"terminals":[{"id":"validate","name":"Validate","kind":"task","action":"validation","command":"test -f shared.txt"}]}],"links":[]}' > patchbay.json
git add .
git commit -qm base
git worktree add -q -b feature "$dir/feature"
printf 'feature\n' > "$dir/feature/shared.txt"
git -C "$dir/feature" add .
git -C "$dir/feature" commit -qm feature
cat > "$dir/agent.py" <<'PYTHON'
import json
import os
import pathlib
import subprocess
import time
import uuid

body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
print(body, flush=True)
assert '## Auto mode' in body
assert 'Goal: Finish the fixture task' in body
journal = pathlib.Path(os.environ['PATCHBAY_REPORT_DIR'])
conversation = str(uuid.uuid4())
turn = str(uuid.uuid4())
def report(event):
    sequence = int((journal / 'sequence').read_text()) + 1 if (journal / 'sequence').exists() else 1
    data = {'session': os.environ['PATCHBAY_REPORT_SESSION'], 'generation': int(os.environ['PATCHBAY_REPORT_GENERATION']), 'provider': 'codex', 'sequence': sequence, 'atMs': int(time.time() * 1000), 'event': event, 'conversation': conversation, 'turn': turn, 'prompt': 'Auto smoke', 'message': None, 'source': None}
    (journal / 'sequence').write_text(str(sequence))
    tmp = journal / 'pending'
    tmp.write_text(json.dumps(data))
    tmp.replace(journal / ('%020d.json' % sequence))
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
def field(name):
    return next(line.split(': ', 1)[1] for line in body.splitlines() if line.startswith(name + ': '))
report('SessionStart')
time.sleep(0.35)  # native providers report idle before their kickoff begins
report('UserPromptSubmit')
time.sleep(0.6)
if 'Stage: plan' in body:
    pathlib.Path(os.environ['PATCHBAY_PLAN_FILE']).write_text('# Fixture description plan\n\nAdd description.txt and commit the implementation.\n')
elif 'Stage: implement' in body:
    pathlib.Path('description.txt').write_text('Implemented from a description\n')
    git('add', 'description.txt')
    git('commit', '-qm', 'Implement fixture description')
elif 'Stage: review' in body:
    path = pathlib.Path(os.environ['PATCHBAY_REVIEW_FILE'])
    fixed = pathlib.Path('shared.txt').read_text() == 'feature fixed\n'
    path.write_text('Verdict: clean\nCounts: {"critical":0,"high":0,"medium":0,"low":0}\nNo findings.\n' if fixed else 'Verdict: issues\nCounts: {"critical":0,"high":1,"medium":0,"low":0}\n[high] shared.txt:1: Fix the fixture text.\n')
elif 'Stage: fix' in body:
    assert '≥ high' in body
    assert 'Commit your work' in body
    pathlib.Path('shared.txt').write_text('feature fixed\n')
    git('add', 'shared.txt')
    git('commit', '-qm', 'Fix fixture finding')
elif 'Stage: merge' in body:
    git('merge', '--no-commit', '--no-ff', field('Source HEAD'))
    git('commit', '-qm', 'Merge Auto fixture')
else:
    raise AssertionError('Unexpected briefing stage')
report('Stop')
print('auto-turn-finished', flush=True)
input()  # controller must stop this session before handing off
PYTHON
