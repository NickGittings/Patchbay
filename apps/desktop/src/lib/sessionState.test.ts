import { expect, test } from 'vitest'
import type { TerminalSnapshot } from '../types'
import { sessionFromSnapshot } from './sessionState'

const snapshot = (generation: number, running: boolean) =>
  ({
    generation,
    running,
    startedMs: generation,
    exitedMs: running ? null : generation + 1,
    exitCode: running ? null : 1,
    status: {},
    notice: null,
    truncated: false,
  }) as unknown as TerminalSnapshot

test('a listing marks only the run it lists interrupted', () => {
  const record = { interrupted: true, snapshot: snapshot(2, false) }
  expect(sessionFromSnapshot(undefined, snapshot(2, false), record).interrupted).toBe(true)
  // A reviewer relaunched after that listing is a newer, running run.
  expect(sessionFromSnapshot(undefined, snapshot(3, true), record).interrupted).toBeUndefined()
  expect(
    sessionFromSnapshot(undefined, snapshot(2, false), { interrupted: true, snapshot: null })
      .interrupted,
  ).toBeUndefined()
})
