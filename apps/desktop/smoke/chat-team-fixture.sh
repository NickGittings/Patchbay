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
assert pathlib.Path(os.environ['PATCHBAY_CONTEXT_FILE']).is_file(), 'The lead or worker lost its project briefing'
tty.setcbreak(sys.stdin.fileno())
journal = pathlib.Path(os.environ['PATCHBAY_REPORT_DIR'])
conversation = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == 'resume' else str(uuid.uuid4())
history = pathlib.Path(os.environ['CODEX_HOME']) / 'sessions' / (conversation + '.jsonl')
history.parent.mkdir(parents=True, exist_ok=True)
history.write_text('{}\n')
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
    response = json.loads(subprocess.check_output([os.environ['PATCHBAY_CLI'], 'agent', *args], text=True))
    if not response['ok']:
        raise RuntimeError(response.get('error'))
    return response['result']

def file_arg(data):
    f = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump(data, f)
    f.close()
    return f.name

worker = os.environ.get('PATCHBAY_ASSIGNMENT_ID')
if not worker:
    bootstrap = 'Reply ‘Ready’ and await the next message. Do not use tools, change files, commit, delegate, or begin previously described work.'
    # Reproduce Codex: no startup event until the initial CLI prompt is present.
    if bootstrap not in sys.argv[1:]:
        while True:
            time.sleep(.1)
    assert sys.argv[1:].count(bootstrap) == 1, 'Duplicate bootstrap prompt'
    report('SessionStart')
    report('UserPromptSubmit')
    time.sleep(.4)
    print('Ready', flush=True)
    report('Stop', reply='Ready')
else:
    report('SessionStart')
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
    elif text == 'ask-fixture' and not worker:
        cli('team-ask', '--id', 'findings-request', '--to', 'inspect', '--text', 'What are your findings and blockers?')
        report('Stop', reply='I requested findings from the existing agent.')
    elif text == 'erase-history-fixture' and not worker:
        history.unlink(missing_ok=True)
        report('Stop', reply='History removed for recovery verification.')
    elif worker:
        state = cli('team')['team']
        for request in state.get('informationRequests', []):
            if request['recipient'] == worker and request['response'] is None:
                cli('team-reply', '--id', request['id'], '--text', 'Inspected the baseline. No blockers; validation reported separately.')
        report('Stop', reply='WORKER-SIDE-THREAD-ONLY')
    else:
        report('Stop', reply='I gathered the existing agent’s findings and will verify its reported validation.' if 'Response to information request' in text else 'The lead received the retained coordination update.')
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
