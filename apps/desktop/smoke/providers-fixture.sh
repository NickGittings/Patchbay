#!/bin/sh
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-providers"
if [ -d "$dir" ]; then
  rm -rf "$dir"
fi
mkdir -p "$dir"
# The smoke runner gives every suite a disposable copy of this project.
mkdir -p "$dir/project"
cd "$dir/project"
git init -q -b main
git config user.name 'Patchbay Smoke'
git config user.email 'smoke@patchbay.invalid'
cat > patchbay.json <<'JSON'
{"schemaVersion":4,"name":"Providers","components":[{"id":"app","name":"App","path":".","kind":"app","notes":"","position":{"x":0,"y":0},"terminals":[{"id":"test","name":"Tests","kind":"task","action":"validation","command":"test -f a.txt && test -f b.txt"}]}],"links":[]}
JSON
printf 'base\n' > shared.txt
git add .
git commit -qm base
cat > "$dir/provider.py" <<'PYTHON'
import json, os, pathlib, subprocess, sys, tempfile, time
role = sys.argv[1]
body = pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).read_text()
print(body, flush=True)
cli = os.environ.get('PATCHBAY_CLI')
def agent(*args):
    result = subprocess.run([cli, 'agent', *args], text=True, capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout)['result']
def submit(command, value):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as f:
        json.dump(value, f); f.flush()
        return agent(command, '--file', f.name)
if role.startswith('scan'):
    submit('scan-report', {'references':['shared.txt:1'], 'findings':role+' finding', 'uncertainties':role+' disagreement', 'suggestedWork':'Add isolated files'})
elif role == 'planner':
    assert 'scan-a finding' in body and 'scan-b finding' in body
    assert 'scan-a disagreement' in body and 'scan-b disagreement' in body
    pathlib.Path(os.environ['PATCHBAY_PLAN_FILE']).write_text('# Provider plan\n\nAdd a.txt and b.txt with isolated workers.\n')
elif role == 'coordinator':
    submit('assignments-create', [dict(id=id, instructions='Add '+id+'.txt', components=['app'], dependencies=[], preset='worker-'+id) for id in ['a','b']])
    agent('assignments-seal')
    deadline=time.time()+45
    while time.time()<deadline:
        status=agent('assignments')
        for job in status['jobs']:
            if job['state']=='complete': agent('assignment-integrate', job['id'])
        if all(job['state']=='integrated' for job in agent('assignments')['jobs']): break
        time.sleep(.15)
    else: raise AssertionError('workers did not integrate')
elif role.startswith('worker'):
    id=os.environ['PATCHBAY_ASSIGNMENT_ID']
    assert not pathlib.Path(('b' if id=='a' else 'a')+'.txt').exists(), 'workers were not isolated'
    pathlib.Path(id+'.txt').write_text('Implemented '+id+'\n')
    subprocess.check_call(['git','add',id+'.txt'])
    subprocess.check_call(['git','-c','user.name=Smoke','-c','user.email=smoke@patchbay.invalid','commit','-qm','Implement '+id])
    head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
    agent('worker-result','--commit',head,'--summary','Implemented '+id)
elif role == 'review':
    assert pathlib.Path('a.txt').exists() and pathlib.Path('b.txt').exists()
    pathlib.Path(os.environ['PATCHBAY_REVIEW_FILE']).write_text('Verdict: clean\nCounts: {"critical":0,"high":0,"medium":0,"low":0}\n\nBoth workers are integrated.\n')
print('provider-finished '+role, flush=True)
PYTHON
