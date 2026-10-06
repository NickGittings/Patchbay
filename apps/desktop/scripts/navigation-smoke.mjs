// Unix desktop fixture. Windows launcher validation remains a release gate.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const root = mkdtempSync(join(tmpdir(), 'patchbay-navigation-smoke-'))
const project = join(root, 'project')
mkdirSync(project)
const git = (args) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' })
git(['init', '-q'])
const target = "target file ; $() ' {line}.txt"
writeFileSync(join(project, target), 'fixture\n')
writeFileSync(join(project, 'tracked.log'), 'tracked\n')
writeFileSync(join(project, 'root-only.txt'), 'untracked in original root\n')
git(['add', target, 'tracked.log'])
writeFileSync(join(project, '.gitignore'), '*.log\n')
writeFileSync(join(project, 'ignored.log'), 'ignored\n')
writeFileSync(join(root, 'secret.txt'), 'outside access\n')
symlinkSync(join(root, 'secret.txt'), join(project, 'escape.txt'))
const editor = join(project, 'editor launcher')
writeFileSync(
  editor,
  '#!/bin/sh\nprintf "EDITOR_ARG:<%s>\\n" "$@" >> "$(dirname "$0")/editor.log"\n',
)
chmodSync(editor, 0o700)
writeFileSync(
  join(project, 'patchbay.json'),
  JSON.stringify({
    schemaVersion: 3,
    name: 'Navigation smoke',
    components: [
      {
        id: 'navigation',
        name: 'Navigation',
        kind: 'other',
        path: '.',
        notes: '',
        position: { x: 0, y: 0 },
        terminals: [{ id: 'shell', name: 'Shell', kind: 'shell', command: '' }],
      },
    ],
    links: [],
  }),
)
git(['add', '.gitignore', 'patchbay.json'])
git([
  '-c',
  'user.name=smoke',
  '-c',
  'user.email=smoke@example.com',
  '-c',
  'commit.gpgsign=false',
  'commit',
  '-qm',
  'fixture',
])
process.env.PATCHBAY_SMOKE_ROOT = project
process.env.PATCHBAY_SMOKE_SCRIPT = resolve(import.meta.dirname, '../smoke/navigation.js')
await import('./smoke.mjs')
