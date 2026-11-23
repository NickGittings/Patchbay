import { expect, expectTypeOf, test } from 'vitest'
import type { ChatTeam } from './lib/chatTeams'
import {
  LEAD_RECIPIENT,
  PLAN_SCOPE,
  PROJECT_SCOPE,
  parseSessionId,
  retask,
  sessionId,
  sessionTask,
  type OwnerKind,
} from './types'

// Mirrors persisted_chat_workflows_and_owners_round_trip_with_existing_wire_values in chat.rs.
test('chat workflows use the persisted wire values', () => {
  type Request = NonNullable<ChatTeam['requests']>[number]
  expectTypeOf<Request['action']>().toEqualTypeOf<
    | 'startAgent'
    | 'startPlan'
    | 'startBuild'
    | 'startReview'
    | 'startFix'
    | 'startMerge'
    | 'startCouncilReview'
    | 'startAuto'
    | 'pauseAuto'
    | 'resumeAuto'
    | 'stopAuto'
    | 'unknown'
  >()
  expectTypeOf<Request['state']>().toEqualTypeOf<
    'queued' | 'waiting' | 'starting' | 'running' | 'completed' | 'uncertain' | 'failed' | 'unknown'
  >()
  expectTypeOf<OwnerKind>().toEqualTypeOf<'chat' | 'auto' | 'unknown'>()
  expect(LEAD_RECIPIENT).toBe('lead')
})

// Pinned in `crates/patchbay-core/src/workspace.rs` too (`session_ids_match_the_frontend`):
// the frontend and the service must hash the same id for a session.
test('sessionId matches the backend hash', () => {
  expect(sessionId('web', 'dev', null, 'p-1')).toBe('s-d17ed5ac1fb0a47bcad00e0ba048bc44')
  expect(sessionId('web', 'dev', 'abc123', 'p-1')).toBe('s-1fd83100e66d2b3b3496518fcb3a11f0')
  expect(sessionId('', '', null, '')).toBe('s-81d23fd7003c2305f25b4ea0b7d9da64')
  expect(sessionId('ünï', 'dev', null, 'p-1')).toBe('s-63e96d0c28b3d68802aa56d2aaa35d63')
})

test('sessionId separates projects, components, terminals and tasks', () => {
  const ids = [
    sessionId('web', 'dev', null, 'p-1'),
    sessionId('web', 'dev', null, 'p-2'),
    sessionId('api', 'dev', null, 'p-1'),
    sessionId('web', 'test', null, 'p-1'),
    sessionId('web', 'dev', 'abc', 'p-1'),
    // Length-prefixed parts, so moving a boundary changes the id.
    sessionId('we', 'bdev', null, 'p-1'),
  ]
  expect(new Set(ids).size).toBe(ids.length)
})

test('ids are parsed from recorded metadata, never from the hash', () => {
  const sid = sessionId('web', 'dev', 'abc', 'p-1')
  expect(parseSessionId(sid)).toEqual({
    projectId: 'p-1',
    componentId: 'web',
    terminalId: 'dev',
    task: 'abc',
  })
  expect(sessionTask(sid)).toBe('abc')
  expect(retask(sid, null)).toBe(sessionId('web', 'dev', null, 'p-1'))
  expect(parseSessionId('s-unknown').componentId).toBe('')
})

test('reserved scopes match the backend', () => {
  expect(PLAN_SCOPE).toBe('@plan')
  expect(PROJECT_SCOPE).toBe('@project')
})
