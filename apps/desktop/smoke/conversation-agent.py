#!/usr/bin/env python3
"""Offline provider fixture. Native reporter and rollout shapes exercise real desktop plumbing."""
import datetime
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

provider = pathlib.Path(sys.argv[0]).name
if sys.argv[1:] == ['auth', 'status']:
    print('{"loggedIn":true}')
    sys.exit(0)
if sys.argv[1:] == ['login', 'status']:
    print('Logged in using ChatGPT')
    sys.exit(0)
if '--version' in sys.argv or '--help' in sys.argv or 'features' in sys.argv:
    print('codex-cli 0.0.0 fixture')
    sys.exit(0)
reporter = pathlib.Path(os.environ['PATCHBAY_STATE_DIR']) / 'reporters/patchbay-status-v1'
conversation = str(uuid.uuid4())
turn = None
retired_turn = None

def hook(event, source=None, identity=None):
    payload = dict(hook_event_name=event, session_id=conversation, turn_id=identity or turn)
    if source:
        payload['source'] = source
    subprocess.run([str(reporter), 'report-status', provider], input=json.dumps(payload), text=True, check=True)

def rollout(payload, kind='event_msg'):
    value = dict(timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(), type=kind, payload=payload)
    with transcript.open('a') as output:
        output.write(json.dumps(value) + '\n')

if provider == 'codex':
    directory = pathlib.Path(os.environ['CODEX_HOME']) / 'sessions/2026/11/10'
    directory.mkdir(parents=True, exist_ok=True)
    transcript = directory / ('rollout-' + conversation + '.jsonl')
    rollout(dict(id=conversation), 'session_meta')
hook('SessionStart', 'startup')
print('fixture-ready ' + conversation, flush=True)
print('args: ' + json.dumps(sys.argv[1:]), flush=True)
for line in sys.stdin:
    command = line.strip()
    if command == 'prompt':
        turn = str(uuid.uuid4())
        hook('UserPromptSubmit')
    elif command == 'approval':
        hook('PermissionRequest')
        time.sleep(0.5)
        hook('PreCompact')
        time.sleep(1)
        hook('PostCompact')
        hook('SessionStart', 'compact')
    elif command == 'context':
        if provider == 'claude':
            payload = dict(session_id=conversation, context_window=dict(context_window_size=200000,
                used_percentage=37, current_usage=dict(input_tokens=14000, cache_creation_input_tokens=10000,
                cache_read_input_tokens=50000)))
            settings = json.loads((pathlib.Path(os.environ['CLAUDE_CONFIG_DIR']) / 'settings.json').read_text())
            subprocess.run(['/bin/sh', '-c', settings['statusLine']['command']], input=json.dumps(payload), text=True, check=True)
        else:
            rollout(dict(type='token_count', info=dict(total_token_usage=dict(total_tokens=900000),
                last_token_usage=dict(total_tokens=74000), model_context_window=200000)))
    elif command == 'precompact':
        hook('PreCompact')
    elif command == 'compact':
        if provider == 'claude':
            hook('PostCompact')
            hook('SessionStart', 'compact')
        else:
            rollout(dict(type='context_compacted'))
    elif command == 'clear':
        retired_turn = turn
        turn = None
        hook('SessionStart', 'clear')
    elif command == 'late-stop':
        hook('Stop', identity=retired_turn)
    elif command == 'stop-turn':
        hook('Stop')
    print('fixture-handled ' + command, flush=True)
