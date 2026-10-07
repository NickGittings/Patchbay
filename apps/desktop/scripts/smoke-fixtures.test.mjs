import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copySmokeProject } from './smoke-fixtures.mjs'

function sourceFor(t) {
  const source = mkdtempSync(join(tmpdir(), 'patchbay-smoke-source-test-'))
  t.after(() => rmSync(source, { recursive: true, force: true }))
  return source
}
function copyFor(t, source, options) {
  const copy = copySmokeProject(source, options)
  t.after(() => rmSync(copy, { recursive: true, force: true }))
  return copy
}

test('both project maps are disposable, uniquely named, and independent of the source Git repo', (t) => {
  const source = sourceFor(t)
  const original = JSON.stringify({
    name: 'Smoke project',
    components: [{ id: 'app', terminals: [] }],
  })
  writeFileSync(join(source, 'patchbay.json'), original)
  execFileSync('git', ['init', '--quiet', source])
  writeFileSync(join(source, '.git', 'source-marker'), 'original repository')
  const one = copyFor(t, source)
  const two = copyFor(t, source, { name: 'Smoke second project' })
  assert.notEqual(one, two)
  assert.equal(JSON.parse(readFileSync(join(one, 'patchbay.json'))).name, 'Smoke project')
  assert.equal(JSON.parse(readFileSync(join(two, 'patchbay.json'))).name, 'Smoke second project')
  for (const fixture of [one, two]) {
    assert.equal(
      execFileSync('git', ['-C', fixture, 'status', '--porcelain'], { encoding: 'utf8' }),
      '',
    )
    assert.equal(existsSync(join(fixture, '.git', 'source-marker')), false)
    writeFileSync(join(fixture, 'patchbay.json'), '{"terminals":["synthetic test command"]}')
  }
  assert.equal(readFileSync(join(source, 'patchbay.json'), 'utf8'), original)
  assert.equal(readFileSync(join(source, '.git', 'source-marker'), 'utf8'), 'original repository')
})

test('Docker detection copies project files without the personal map or Git metadata', (t) => {
  const source = sourceFor(t)
  const compose = 'services:\n  hello:\n    image: alpine:3\n'
  const personal = '{"name":"Personal Docker map"}'
  writeFileSync(join(source, 'compose.yaml'), compose)
  writeFileSync(join(source, 'patchbay.json'), personal)
  mkdirSync(join(source, '.git'))
  writeFileSync(join(source, '.git', 'source-marker'), 'original repository')
  const fixture = copyFor(t, source, { skipMap: true })
  assert.equal(readFileSync(join(fixture, 'compose.yaml'), 'utf8'), compose)
  assert.equal(existsSync(join(fixture, 'patchbay.json')), false)
  assert.equal(existsSync(join(fixture, '.git', 'source-marker')), false)
  writeFileSync(join(fixture, 'patchbay.json'), '{"name":"Detected map"}')
  writeFileSync(join(fixture, 'compose.yaml'), 'changed by test')
  assert.equal(readFileSync(join(source, 'patchbay.json'), 'utf8'), personal)
  assert.equal(readFileSync(join(source, 'compose.yaml'), 'utf8'), compose)
})
