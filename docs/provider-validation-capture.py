"""Capture provider hook inputs from disposable workspaces. See provider-validation.md."""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread


def capture(log, event, question_probe):
    payload = json.load(sys.stdin)
    with log.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(payload) + '\n')
    if event == 'PreToolUse':
        if question_probe and payload['toolCall']['name'] == 'ask_question':
            print(json.dumps({'decision': 'deny', 'reason': 'Patchbay answer: Blue'}))
        else:
            print('{"decision":"allow"}')
    else:
        print('{}')


def hook(log, event, question_probe=False):
    command = [sys.executable, str(Path(__file__).resolve()), '_hook', str(log), event]
    if question_probe:
        command.append('question')
    return {'type': 'command', 'command': shlex.join(command), 'timeout': 30}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def run_antigravity(binary, root, env, probe):
    workspace = root / 'workspace'
    workspace.mkdir()
    sample = workspace / 'validation.txt'
    sample.write_text('PATCHBAY_VALIDATION\n', encoding='utf-8')
    question_probe = probe == 'antigravity-question'
    log = root / 'hooks.jsonl'
    hooks = {}
    for event in ('SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'):
        hooks[event] = [hook(log, event)]
    for event in ('PreToolUse', 'PostToolUse'):
        hooks[event] = [{'matcher': '.*', 'hooks': [hook(log, event, question_probe)]}]
    write_json(workspace / '.agents/hooks.json', {'patchbay-validation': hooks})

    class GeminiStub(BaseHTTPRequestHandler):
        def reply(self, data, content_type):
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            model = {'name': 'models/gemini-2.5-flash',
                     'supportedGenerationMethods': ['generateContent']}
            self.reply(json.dumps({'models': [model]}).encode(), 'application/json')

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            has_response = any(
                'functionResponse' in part
                for content in request.get('contents', [])
                for part in content.get('parts', [])
            )
            tool = 'ask_question' if question_probe else 'read_file'
            args = {'Path': str(sample)}
            if question_probe:
                args = {'questions': [
                    {'question': 'Pick a color', 'options': ['Blue', 'Red'],
                     'is_multi_select': False},
                ]}
            part = {'text': 'PATCHBAY_VALIDATION'} if has_response else {
                'functionCall': {'name': tool, 'args': args},
            }
            response = {
                'candidates': [
                    {'content': {'role': 'model', 'parts': [part]},
                     'finishReason': 'STOP', 'index': 0},
                ],
                'usageMetadata': {
                    'promptTokenCount': 4, 'candidatesTokenCount': 2, 'totalTokenCount': 6,
                },
            }
            self.reply(b'data: ' + json.dumps(response).encode() + b'\n\n', 'text/event-stream')

    prompt = ('Ask me to pick a color, Blue or Red, before continuing.' if question_probe
              else 'Read validation.txt and report its exact contents.')
    with ThreadingHTTPServer(('127.0.0.1', 0), GeminiStub) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            env.update(GEMINI_API_KEY='patchbay-validation-placeholder',
                       GOOGLE_GEMINI_BASE_URL=f'http://127.0.0.1:{server.server_port}')
            subprocess.run(
                [binary, '--settings', '{"modelProvider":"gemini"}',
                 '--log-file', str(root / 'antigravity.log'),
                 '--print-timeout', '15s', '-p', prompt],
                cwd=workspace, env=env, timeout=25, check=True,
            )
        finally:
            server.shutdown()
            worker.join()


def run_muse(binary, root, env):
    workspace = root / 'workspace'
    workspace.mkdir()
    env.update(MUSE_NO_AUTO_UPDATE='1', XDG_CONFIG_HOME=str(root / 'config'),
               XDG_DATA_HOME=str(root / 'data'), XDG_CACHE_HOME=str(root / 'cache'))
    events = ('SessionStart', 'UserPromptSubmit', 'PreLLMCall', 'PostLLMCall',
              'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd')
    log = root / 'hooks.jsonl'
    write_json(root / 'config/muse/settings.json', {
        'schema_version': 1,
        'hooks': {event: [{'hooks': [hook(log, event)]}] for event in events},
    })
    subprocess.run([binary, 'exec', '--provider', 'echo', 'Reply with PATCHBAY_VALIDATION'],
                   cwd=workspace, env=env, timeout=30, check=True)


def main():
    if sys.argv[1:2] == ['_hook']:
        _, _, log, event, *options = sys.argv
        capture(Path(log), event, options == ['question'])
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('probe', choices=['antigravity-read', 'antigravity-question', 'muse'])
    parser.add_argument('binary', type=Path, help='Path to the tested CLI binary')
    parser.add_argument('output', type=Path, help='New directory for the workspace and capture')
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(mode=0o700)
    home = root / 'home'
    home.mkdir()
    env = {'HOME': str(home), 'PATH': os.environ.get('PATH', os.defpath)}
    binary = str(args.binary.resolve(strict=True))
    if args.probe == 'muse':
        run_muse(binary, root, env)
    else:
        run_antigravity(binary, root, env, args.probe)
    if not (root / 'hooks.jsonl').is_file():
        raise SystemExit('The CLI did not run the capture hooks.')
    print(root / 'hooks.jsonl')


if __name__ == '__main__':
    main()
