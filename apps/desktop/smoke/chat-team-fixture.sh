#!/bin/sh
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-team"
rm -rf "$dir"
mkdir -p "$dir/project/src"
cd "$dir/project"
git init -q -b main
git config user.name 'Team smoke'
git config user.email team@patchbay.invalid
git config commit.gpgsign false
printf 'base\n' > src/app.txt
printf '%s\n' '{"schemaVersion":4,"name":"Team smoke","components":[{"id":"app","name":"App","path":"src","kind":"app","position":{"x":0,"y":0},"terminals":[]}],"links":[]}' > patchbay.json
git add .
git commit -qm base
cat > "$dir/agent.py" <<'PYTHON'
import json, os, pathlib, subprocess, sys, tempfile, time, tty, uuid
tty.setcbreak(sys.stdin.fileno())
journal = pathlib.Path(os.environ['PATCHBAY_REPORT_DIR'])
conversation = str(uuid.uuid4())
turn = str(uuid.uuid4())
sequence = 0

def report(event, **extra):
    global sequence
    sequence += 1
    data = dict(session=os.environ['PATCHBAY_REPORT_SESSION'], generation=int(os.environ['PATCHBAY_REPORT_GENERATION']), provider=os.environ['PATCHBAY_REPORT_PROVIDER'], sequence=sequence, atMs=int(time.time()*1000), event=event, conversation=conversation, turn=turn)
    data.update(extra)
    if 'reply' in extra:
        data['last_assistant_message'] = extra['reply']
    tmp = journal / 'pending'
    tmp.write_text(json.dumps(data))
    tmp.replace(journal / ('%020d.json' % sequence))

def cli(*args):
    return json.loads(subprocess.check_output([os.environ['PATCHBAY_CLI'], 'agent', *args], text=True))

def file_arg(data):
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump(data, f)
    f.close()
    return f.name

report('SessionStart')
worker = os.environ.get('PATCHBAY_ASSIGNMENT_ID')
if worker:
    report('UserPromptSubmit')
    time.sleep(4)
    if worker == 'inspect':
        cli('team-report', '--summary', 'Inspected the committed baseline; report complete.')
    else:
        pathlib.Path('src/worker.txt').write_text('worker implementation\n')
        subprocess.check_call(['git', 'add', 'src/worker.txt'])
        subprocess.check_call(['git', 'commit', '-qm', 'Worker implementation'])
        commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
        cli('team-result', '--commit', commit, '--summary', 'Implemented worker file; committed and verified.')
    report('Stop', reply='WORKER-SIDE-THREAD-ONLY')
print('team-ready', flush=True)
buffer = ''
for line in sys.stdin:
    buffer += line
    if '\x1b[200~' in buffer and '\x1b[201~' not in buffer:
        continue
    text = buffer.replace('\x1b[200~', '').replace('\x1b[201~', '').strip()
    buffer = ''
    if not text:
        continue
    turn = str(uuid.uuid4())
    report('UserPromptSubmit')
    if 'delegate-fixture' in text and not worker:
        checkpoint = file_arg(dict(goal='Fixture goal', constraints='Keep user edits', decisions='Use two isolated workers', remaining='Inspect and implement', validation='Pending'))
        cli('team-checkpoint', '--file', checkpoint)
        assignments = file_arg([dict(id='inspect', instructions='Inspect baseline', components=['app'], dependencies=[], preset='team-agent', resultKind='report'), dict(id='build', instructions='Implement worker file', components=['app'], dependencies=[], preset='team-agent', resultKind='code')])
        cli('team-delegate', '--id', 'round1', '--file', assignments)
        os.unlink(checkpoint)
        os.unlink(assignments)
        report('Stop', reply='The lead delegated two assignments.')
    else:
        report('Stop', reply='The lead received the retained coordination update.' if not worker else 'Worker received the side message.')
PYTHON
cat > "$dir/codex" <<SH
#!/bin/sh
if [ "\${1:-}" = login ] && [ "\${2:-}" = status ]; then
  printf 'Logged in using ChatGPT\n'
  exit 0
fi
exec python3 '$dir/agent.py' "\$@"
SH
chmod +x "$dir/codex"
