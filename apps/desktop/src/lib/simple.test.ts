import { expect, test } from 'vitest'
import {
  simplePanelLayout,
  withoutHierarchy,
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
  expect(model.items.filter((i) => i.kind === 'agent').map((i) => i.sessionId)).toEqual([
    'p',
    'root',
  ])
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
  expect(
    thread({ ...snapshot([]), plan: { text: 'saved', cut: false, savedMs: 1 } }, worktree)
      .planReady,
  ).toBe(true)
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

test('legacy Navigation sizing adds only a collapsed chat slot and Simple sizes stay independent', () => {
  const full = { 'App-pane-1': 14, 'App-pane-2': 62, 'App-pane-5': 24 }
  expect(simplePanelLayout(full)).toEqual({ ...full, 'App-simple-chat': 0 })
  expect(full).not.toHaveProperty('App-simple-chat')
  const simple = { ...full, 'App-simple-chat': 35 }
  expect(simplePanelLayout(simple)).toBe(simple)
})

test('layouts from before the Hierarchy panel went give its width to the canvas', () => {
  const old = { 'App-pane-1': 14, 'App-pane-2': 62, 'App-simple-chat': 0, 'App-pane-5': 24 }
  expect(withoutHierarchy(old)).toEqual({
    'App-pane-2': 76,
    'App-simple-chat': 0,
    'App-pane-5': 24,
  })
  const current = { 'App-pane-2': 76, 'App-pane-5': 24 }
  expect(withoutHierarchy(current)).toBe(current)
  expect(withoutHierarchy(undefined)).toBeUndefined()
})

test('a newly used shared planner cannot reset another worktree stage', () => {
  const model = thread(
    snapshot([record('build', '@task', 't', 2), record('shared', '@plan', null, 100)]),
    worktree,
  )
  expect(model.stage).toBe('build')
})

test('timeline groups consecutive messages and deduplicates replies against live snapshots', () => {
  const r = record('plan', '@plan', null, 10)
  const entries = [
    {
      id: 'prompt',
      atMs: 10,
      kind: 'prompt' as const,
      stage: 'plan' as const,
      sessionId: 'plan',
      generation: 1,
      text: 'Feature',
      mentions: [],
    },
    {
      id: 'reply',
      atMs: 20,
      kind: 'reply' as const,
      stage: 'plan' as const,
      sessionId: 'plan',
      generation: 1,
      sequence: 2,
      text: 'Plan ready.',
    },
  ]
  const model = thread(
    {
      ...snapshot([r]),
      simple: { startedMs: 10, log: entries },
      sessions: {
        plan: {
          generation: 1,
          running: true,
          replies: [{ atMs: 20, sequence: 2, text: 'Plan ready.', turn: null }],
        },
      },
      plan: { text: '# Plan', cut: false, savedMs: 15 },
    },
    worktree,
  )
  expect(model.items.map((i) => i.kind)).toEqual(['line', 'agent', 'plan'])
  expect(model.items[1]).toMatchObject({ entries })
  expect(model.planReady).toBe(true)
  const stale = thread(
    { ...snapshot([]), createdMs: 30, plan: { text: '# Old', cut: false, savedMs: 20 } },
    worktree,
  )
  expect(stale.planReady).toBe(false)
  expect(stale.items[0]).toMatchObject({ kind: 'plan', stale: true })
})
test('restoring replies validates journal identities and deduplicates across entry ids', () => {
  const reply = {
    kind: 'reply',
    stage: 'build',
    id: 'a',
    atMs: 10,
    sessionId: 's',
    generation: 1,
    sequence: 2,
    text: 'Reply',
  }
  expect(
    restoredSimple({
      startedMs: 1,
      log: [
        reply,
        { ...reply, id: 'b' },
        { ...reply, id: 'c', sequence: -1 },
        { ...reply, id: 'd', generation: 2 },
      ],
    })?.log,
  ).toEqual([reply, { ...reply, id: 'd', generation: 2 }])
})

test('a story planning action remains the boundary when its process starts a moment later', () => {
  const r = record('plan', '@plan', null, 11)
  r.snapshot!.generation = 1
  const s = {
    ...snapshot([r]),
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'story',
          kind: 'action' as const,
          action: 'plan' as const,
          stage: 'plan' as const,
          sessionId: 'plan',
          generation: 1,
          atMs: 10,
          text: 'Story',
        },
      ],
    },
    plan: { text: 'Plan', cut: false, savedMs: 12 },
  }
  expect(thread(s, worktree)).toMatchObject({ planningStarted: 10, planReady: true })
  r.snapshot!.generation = 2
  r.snapshot!.startedMs = 20
  expect(thread(s, worktree)).toMatchObject({ planningStarted: 20, planReady: false })
})
