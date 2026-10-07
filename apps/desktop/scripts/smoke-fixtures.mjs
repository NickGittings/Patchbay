// Source projects are templates only. Retain disposable copies for smoke failure inspection.
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export function copySmokeProject(source, { name, skipMap = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'patchbay-smoke-project-'))
  cpSync(source, fixture, {
    recursive: true,
    filter: (path) => basename(path) !== '.git' && !(skipMap && basename(path) === 'patchbay.json'),
  })
  if (name) {
    const file = join(fixture, 'patchbay.json')
    const project = JSON.parse(readFileSync(file, 'utf8'))
    project.name = name
    writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`)
  }
  execFileSync('git', ['init', '--quiet', '-b', 'main', fixture])
  execFileSync('git', ['-C', fixture, 'add', '.'])
  execFileSync('git', [
    '-C',
    fixture,
    '-c',
    'user.name=Patchbay Smoke',
    '-c',
    'user.email=smoke@patchbay.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Initialize smoke fixture',
  ])
  return fixture
}
