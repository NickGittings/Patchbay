import { expect, test } from 'vitest'
import { focusWork, leadStories, setAllWork, useAllWork, worktreesOf } from './workFocus'
import { useStore } from '../store'
import type { ChatTeam } from './chatTeams'
import type { Task } from '../types'

test('the lead’s stories are those its unsettled startAuto requests name', () => {
  const request = (story: string, state: string, action = 'startAuto') => ({
    id: story,
    action,
    state,
    settings: { story },
    result: null,
  })
  const requests = [
    request('running', 'running'),
    request('queued', 'queued'),
    request('done', 'completed'),
    request('plan', 'running', 'startPlan'),
  ] as NonNullable<ChatTeam['requests']>
  expect([...leadStories(requests)].sort()).toEqual(['queued', 'running'])
  expect(leadStories(undefined).size).toBe(0)
})

test('All work badges name each open worktree that works on a component', () => {
  const tasks = [
    { id: 'a', components: ['web'], missing: false },
    { id: 'b', components: ['web', 'api'], missing: false },
    { id: 'gone', components: ['web'], missing: true },
  ] as Task[]
  expect(worktreesOf(tasks, 'web').map((t) => t.id)).toEqual(['a', 'b'])
  expect(worktreesOf(tasks, 'docs')).toEqual([])
})

test('a worktree sees only the lead’s requests there, and its status where it works now', async () => {
  const { focusTeam } = await import('./chatTeams')
  const request = (
    id: string,
    settings: Record<string, unknown>,
    result: string | null = null,
  ) => ({
    id,
    action: 'startBuild' as const,
    state: 'running' as const,
    settings,
    result,
  })
  const team = {
    task: null,
    status: { step: 'building', atMs: 1 },
    requests: [
      request('here', {}),
      request('story', { newWorktree: true }, JSON.stringify({ task: 'b' })),
      request('there', { worktree: 'a' }),
    ],
  } as unknown as ChatTeam
  const ids = (task: string | null) => focusTeam(team, task)!.requests!.map((r) => r.id)
  expect(ids(null)).toEqual(['here'])
  expect(ids('a')).toEqual(['there'])
  expect(ids('b')).toEqual(['story'])
  // The latest stage runs in `a`, so the lead's status belongs there.
  expect(focusTeam(team, 'a')!.status).toEqual(team.status)
  expect(focusTeam(team, null)!.status).toBeNull()
})

test('Auto controls show under the run they control; a settled story Auto under its story', async () => {
  const { requestWorktree } = await import('./chatTeams')
  const started = {
    id: 'auto1',
    action: 'startAuto' as const,
    state: 'completed' as const,
    settings: { worktree: 'login' },
    result: 'Auto in login is done.',
  }
  const stop = {
    id: 'stop',
    action: 'stopAuto' as const,
    state: 'completed' as const,
    settings: { request: 'auto1' },
    result: null,
  }
  const team = { task: null, projectId: 'p', requests: [started, stop] } as unknown as ChatTeam
  expect(requestWorktree(team, stop)).toBe('login')
  useStore.setState({
    projects: { p: { state: { stories: [{ id: 's1', task: 'story-wt' }] } } },
  } as never)
  const story = {
    id: 'story',
    action: 'startAuto' as const,
    state: 'completed' as const,
    settings: { newWorktree: true, story: 's1' },
    result: 'Auto in story-wt is done.',
  }
  expect(requestWorktree(team, story)).toBe('story-wt')
  useStore.setState(useStore.getInitialState())
})

test('focusing a missing worktree leaves All work on', () => {
  useStore.setState({
    project: { id: 'p' },
    tasks: [{ id: 'gone', missing: true }],
    activeTask: null,
  } as never)
  setAllWork('p', true)
  focusWork('gone')
  expect(useAllWork.getState().projects.p).toBe(true)
  expect(useStore.getState().activeTask).toBeNull()
  useStore.setState(useStore.getInitialState())
})
