import { expect, test } from 'vitest'
import {
  relatedSession,
  selectRecipient,
  thread,
  restoredSimple,
  type SimpleSnapshot,
} from './simple'
import type { SessionRecord } from '../types'
const worktree = { projectId: 'p', task: 't', path: '/t', branch: 'feature' }
const record = (id: string, scope: string, task: string | null, atMs = 1): SessionRecord =>
  ({
    id,
    metadata: { projectId: 'p', kind: 'agent', componentId: scope, task },
    spec: { cwd: task ? '/t' : '/p' },
    snapshot: { startedMs: atMs, running: true },
    history: [],
  }) as unknown as SessionRecord
const snapshot = (records: SessionRecord[]): SimpleSnapshot => ({
  records,
  sessions: {},
  simple: null,
  auto: null,
})
test('stable stages isolate projects/worktrees and explicitly share only planners', () => {
  const planner = record('p', '@plan', null),
    other = record('other', 'app', 'other')
  const model = thread(snapshot([planner, other, record('root', '@task', 't')]), worktree)
  expect(model.sections.map((s) => s.id)).toEqual(['plan', 'build', 'review', 'merge'])
  expect(model.records.map((r) => r.id)).toEqual(['p', 'root'])
  expect(
    relatedSession({ ...planner, metadata: { ...planner.metadata, projectId: 'other' } }, worktree),
  ).toBe(false)
  expect(model.stage).toBe('build')
})
test('latest recovered review wins, recipient override survives while eligible', () => {
  const records = [
    record('plan', '@plan', null, 1),
    record('build', '@task', 't', 2),
    record('review', '@review', 't', 3),
  ]
  expect(thread(snapshot(records), worktree).stage).toBe('review')
  expect(selectRecipient(records, {}, 'review')?.id).toBe('review')
  expect(selectRecipient(records, {}, 'review', 'build')?.id).toBe('build')
  expect(selectRecipient(records, {}, 'review', 'gone')?.id).toBe('review')
})
test('plan readiness uses saved artifacts and complete log restoration has stable identities', () => {
  expect(thread(snapshot([]), worktree).planReady).toBe(false)
  expect(thread({ ...snapshot([]), plan: { text: 'saved', cut: false } }, worktree).planReady).toBe(
    true,
  )
  const entry = {
    id: '1',
    atMs: 1,
    stage: 'plan',
    kind: 'prompt',
    text: ' exact\ntext ',
    mentions: ['a'],
  }
  const restored = restoredSimple({ startedMs: 1, log: [entry, entry, { id: 'bad' }] })
  expect(restored?.log).toEqual([entry])
  expect(restoredSimple(null)).toBeNull()
})
