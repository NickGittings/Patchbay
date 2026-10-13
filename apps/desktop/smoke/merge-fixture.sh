#!/bin/sh
# Disposable clean and conflicting destinations for the Review merge smoke test.
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-merge"
rm -rf "$dir"
mkdir -p "$dir/project"
cd "$dir/project"
git init -q -b main
git config user.name 'Merge smoke'
git config user.email merge@patchbay.invalid
git config commit.gpgsign false
printf 'base\n' > shared.txt
printf '%s\n' '{"schemaVersion":4,"name":"Merge smoke","components":[],"links":[]}' > patchbay.json
git add .
git commit -qm base
git worktree add -q -b feature "$dir/feature"
git worktree add -q -b integration "$dir/integration"
printf 'feature\n' > "$dir/feature/shared.txt"
git -C "$dir/feature" add .
git -C "$dir/feature" commit -qm feature
printf 'main\n' > shared.txt
git add .
git commit -qm main
cat > "$dir/agent.py" <<'PY'
import os
import pathlib
import subprocess

body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
print(body, flush=True)
def field(name):
    return next(line.split(': ', 1)[1] for line in body.splitlines() if line.startswith(name + ': '))
def git(cwd, *args):
    return subprocess.run(['git', '-C', cwd, *args], capture_output=True, text=True)
source, destination = field('Source worktree'), field('Destination worktree')
assert pathlib.Path.cwd().resolve() == pathlib.Path(destination).resolve()
for role, cwd in [('Source', source), ('Destination', destination)]:
    assert git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.strip() == field(role + ' branch')
    assert git(cwd, 'rev-parse', 'HEAD').stdout.strip() == field(role + ' HEAD')
    assert not git(cwd, 'status', '--porcelain', '--untracked-files=all').stdout.strip()
result = git(destination, 'merge', '--no-commit', '--no-ff', field('Source HEAD'))
if result.returncode:
    assert git(destination, 'diff', '--name-only', '--diff-filter=U').stdout.strip() == 'shared.txt'
    pathlib.Path(destination, 'shared.txt').write_text('main\nfeature\n')
    assert git(destination, 'add', 'shared.txt').returncode == 0
    print('merge-result:resolved-conflict', flush=True)
else:
    print('merge-result:clean', flush=True)
assert git(destination, 'diff', '--check').returncode == 0
assert git(destination, 'commit', '-qm', 'Merge smoke feature').returncode == 0
assert git(destination, 'merge-base', '--is-ancestor', field('Source HEAD'), 'HEAD').returncode == 0
assert not git(destination, 'status', '--porcelain').stdout.strip()
print('merge-verified:' + destination, flush=True)
# Keep the terminal running to exercise duplicate prevention, recovery, and Stop.
input()
PY

cat > "$dir/review.py" <<'PYTHON'
import os
import pathlib
import subprocess
import time

status = pathlib.Path(os.environ['PATCHBAY_STATUS_FILE'])
status.write_text('working\n')
body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
print(body, flush=True)
before = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'])
time.sleep(0.05)  # findings must postdate the kickoff sidecar
path = pathlib.Path(os.environ['PATCHBAY_REVIEW_FILE'])
path.write_text('P2 shared.txt:1: Smoke review finding\n')
assert subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all']) == before
print('review-file:' + str(path), flush=True)
print('review-verified', flush=True)
input()  # exercise the running guard while working
status.write_text('review\n')
print('review-idle', flush=True)
input()  # settled at its prompt, like an interactive agent, before an ordinary exit
PYTHON

cat > "$dir/fix.py" <<'PYTHON'
import os
import pathlib

body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
assert '## Review findings' in body
assert 'Smoke review finding' in body
assert 'addressing the review findings below' in body
assert 'PATCHBAY_REVIEW_FILE' not in os.environ
print(body, flush=True)
print('fix-verified:' + str(pathlib.Path.cwd()), flush=True)
PYTHON
