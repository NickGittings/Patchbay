import { describe, expect, test } from 'vitest'
import type { ChangedFile, SessionState, TerminalSpec } from '../types'
import { sessionId, setProjectIdentity } from '../types'
import {
  ago,
  latestChange,
  latestChangeOf,
  lineTotals,
  pathWithin,
  splitPath,
  validations,
} from './review'

setProjectIdentity('p-1')

const file = (path: string, modifiedMs?: number, added?: number, removed?: number) =>
  ({ path, kind: 'modified', modifiedMs, added, removed }) satisfies ChangedFile

describe('latestChange', () => {
  test('is the newest modification time; deletions have none', () => {
    const deleted: ChangedFile = { path: 'gone.ts', kind: 'deleted' }
    expect(latestChange([file('a', 5), deleted, file('c', 9)])).toBe(9)
    expect(latestChange([deleted])).toBeUndefined()
    expect(latestChange(undefined)).toBeUndefined()
  })

  test('across components covers only the ones asked for', () => {
    const changes = { web: [file('a', 5)], api: [file('b', 20)], db: [file('c', 30)] }
    expect(latestChangeOf(changes, ['web', 'api'])).toBe(20)
    expect(latestChangeOf(changes, ['missing'])).toBeUndefined()
  })
})

describe('validations', () => {
  const task = (id: string): TerminalSpec => ({ id, name: id, command: id, kind: 'task' })
  const terminals = [
    task('notRun'),
    task('running'),
    task('passed'),
    task('failed'),
    task('stale'),
    { id: 'shell', name: 'Shell', command: '', kind: 'shell' } satisfies TerminalSpec,
  ]
  const sid = (id: string, t: string | null = null) => sessionId('web', id, t)
  const done = (exitCode: number, startedMs: number): SessionState => ({
    running: false,
    exitCode,
    startedMs,
  })

  test('judges each task terminal against the latest change', () => {
    const sessions: Record<string, SessionState> = {
      [sid('running')]: { running: true, startedMs: 1 },
      [sid('passed')]: done(0, 100),
      [sid('failed')]: done(1, 100),
      [sid('stale')]: done(0, 10),
    }
    const states = validations('web', terminals, sessions, 50).map((v) => [v.terminal.id, v.state])
    expect(states).toEqual([
      ['notRun', 'notRun'],
      ['running', 'running'],
      ['passed', 'passed'],
      ['failed', 'failed'],
      ['stale', 'stale'],
    ])
  })

  test('a run before any timed change still counts', () => {
    const sessions = { [sid('passed')]: done(0, 10) }
    expect(validations('web', [task('passed')], sessions, undefined)[0].state).toBe('passed')
  })

  test('reads sessions from the task scope', () => {
    const sessions = { [sid('passed', 'abc')]: done(0, 100) }
    expect(validations('web', [task('passed')], sessions, 50)[0].state).toBe('notRun')
    expect(validations('web', [task('passed')], sessions, 50, 'abc')[0].state).toBe('passed')
  })
})

test('ago rounds to the largest whole unit', () => {
  const now = 1_000_000_000
  expect(ago(now - 4_000, now)).toBe('4s ago')
  expect(ago(now - 125_000, now)).toBe('2m ago')
  expect(ago(now - 3 * 3_600_000, now)).toBe('3h ago')
  expect(ago(now - 2 * 86_400_000, now)).toBe('2d ago')
  expect(ago(now + 5_000, now)).toBe('0s ago')
})

test('paths are shown relative to their component', () => {
  expect(pathWithin('apps/web/src/a.ts', 'apps/web')).toBe('src/a.ts')
  expect(pathWithin('apps/web/src/a.ts', 'apps/web/')).toBe('src/a.ts')
  expect(pathWithin('apps/webby/a.ts', 'apps/web')).toBe('apps/webby/a.ts')
  expect(pathWithin('a.ts', '.')).toBe('a.ts')
  expect(splitPath('src/lib/a.ts')).toEqual(['src/lib/', 'a.ts'])
  expect(splitPath('a.ts')).toEqual(['', 'a.ts'])
})

test('lineTotals skips files without counts', () => {
  expect(lineTotals([file('a', 1, 3, 1), file('bin.png', 1), file('b', 1, 2, 5)])).toEqual({
    added: 5,
    removed: 6,
  })
})
