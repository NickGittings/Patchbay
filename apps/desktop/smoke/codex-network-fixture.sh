#!/bin/sh
# Exercise the installed Codex sandbox, without model calls or user configuration writes.
set -eu
dir="${TMPDIR:-/tmp}/patchbay-smoke-codex-network"
rm -rf "$dir"
mkdir -p "$dir/project" "$dir/home" "$dir/home-named"
command -v codex > "$dir/real-codex"
cat > "$dir/home/config.toml" <<'TOML'
default_permissions = "scoped"
[permissions.scoped]
extends = ":read-only"
[permissions.scoped.filesystem]
":workspace_roots" = "write"
TOML
cat > "$dir/home-named/config.toml" <<'TOML'
default_permissions = "locked"
[permissions.locked]
extends = ":workspace"
[permissions.locked.network.domains]
"127.0.0.1" = "deny"
TOML
cat > "$dir/project/patchbay.json" <<'JSON'
{"schemaVersion":4,"name":"Codex networking","components":[{"id":"web","name":"Web","path":".","kind":"frontend","notes":"","position":{"x":0,"y":0},"terminals":[{"id":"check","name":"Check","kind":"task","action":"validation","command":"printf 'configured-validation-passed\\n'"}]}],"links":[]}
JSON
cat > "$dir/project/proposal.json" <<'JSON'
{"version":1,"plan":"# Scoped TCP plan\nImplement through the authenticated bridge.","assignments":[{"componentId":"web","assignment":"Verify the configured validation."}]}
JSON
cat > "$dir/codex" <<'PYTHON'
#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(__file__).parent
if sys.argv[-2:] == ['login', 'status']:
    print('Logged in using ChatGPT')  # Scripted sandbox probe; no model authentication needed.
    sys.exit(0)
args = iter(sys.argv[1:])
overrides, writable = [], []
for arg in args:
    if arg in ('-c', '--config'):
        overrides.extend(['-c', next(args)])
    elif arg == '--add-dir':
        writable.append(next(args))
    elif arg == '--strict-config':
        pass
    else:
        raise AssertionError('Unexpected probe launch argument: '+arg)
if writable:
    filesystem = {':workspace_roots':'write', **{path:'write' for path in writable}}
    overrides.extend(['-c', 'permissions.scoped.filesystem={'+','.join(json.dumps(k)+'='+json.dumps(v) for k,v in filesystem.items())+'}'])
if os.environ['PATCHBAY_NETWORK_PROBE_ROLE'] == 'restricted':
    overrides.extend(['-c', 'features.network_proxy=false', '-c', 'permissions.scoped.network.enabled=false'])
real = (root/'real-codex').read_text().strip()
# The TUI accepts --strict-config; the standalone sandbox subcommand rejects it.
profile = 'locked' if os.environ['PATCHBAY_NETWORK_PROBE_ROLE'] == 'denied-named' else 'scoped'
os.execv(real, [real, *overrides, 'sandbox', '-P', profile, '--', sys.executable, str(root/'agent.py')])
PYTHON
chmod +x "$dir/codex"
cat > "$dir/agent.py" <<'PYTHON'
import json, os, pathlib, socket, struct, subprocess, urllib.parse
root = pathlib.Path(__file__).parent
role = os.environ['PATCHBAY_NETWORK_PROBE_ROLE']
cli = os.environ['PATCHBAY_CLI']
def agent(*args, success=True):
    result = subprocess.run([cli, 'agent', *args], capture_output=True, text=True)
    print(result.stdout, flush=True)
    assert (result.returncode == 0) == success, result.stdout+result.stderr
    return json.loads(result.stdout)
if role == 'restricted':
    reply = agent('status', success=False)
    assert 'Permission denied connecting' in reply['error'], reply
    print('original-restricted-tcp-failure', flush=True)
    print('codex-network-finished '+role, flush=True)
    raise SystemExit(0)
assert os.environ.get('CODEX_NETWORK_PROXY_ACTIVE') == '1'
if role.startswith('denied'):
    reply = agent('status', success=False)
    assert 'SOCKS' in reply['error'] and 'denied' in reply['error'], reply
else:
    # The same sandbox still rejects a raw socket to the allowed bridge IP.
    endpoint = pathlib.Path(os.environ['PATCHBAY_AGENT_ENDPOINT']).read_text().strip()
    host, port = endpoint.rsplit(':', 1)
    try:
        socket.create_connection((host, int(port)), 2)
    except PermissionError:
        print('direct-tcp-blocked', flush=True)
    else:
        raise AssertionError('Direct socket bypassed the managed proxy')
    agent('status')
    if role == 'planner':
        proposal = json.loads((root/'project/proposal.json').read_text())
        pathlib.Path(os.environ['PATCHBAY_PLAN_FILE']).write_text(proposal['plan'])
        agent('propose', '--file', str(root/'project/proposal.json'))
    else:
        reply = agent('validate', 'web')
        assert reply['result']['passed'], reply
    # Attempt an unapproved loopback IP through the same managed proxy.
    proxy = urllib.parse.urlparse(os.environ['ALL_PROXY'])
    with socket.create_connection((proxy.hostname, proxy.port), 2) as stream:
        stream.sendall(bytes([5,1,0])); assert stream.recv(2) == bytes([5,0])
        stream.sendall(bytes([5,1,0,1,127,0,0,2])+struct.pack('!H',12345))
        reply = stream.recv(4)
        assert len(reply) == 4 and reply[1] != 0, reply
    print('unapproved-destination-blocked', flush=True)
    # Command networking must not make a sibling directory writable.
    try:
        (root/'outside-workspace').write_text('must be denied')
    except PermissionError:
        print('filesystem-restriction-preserved', flush=True)
    else:
        raise AssertionError('Networking widened filesystem permissions')
print('codex-network-finished '+role, flush=True)
PYTHON
cd "$dir/project"
git init -q -b main
git -c user.name=smoke -c user.email=smoke@example.com add .
git -c user.name=smoke -c user.email=smoke@example.com -c commit.gpgsign=false commit -qm init
