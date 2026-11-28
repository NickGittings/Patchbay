import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../store', async (original) => ({
  ...(await original<typeof import('../store')>()),
  projectStateOf: vi.fn(),
}))
vi.mock('./chatTeams', async (original) => ({
  ...(await original<typeof import('./chatTeams')>()),
  controlTeam: vi.fn(),
}))
import { projectStateOf } from '../store'
import type { AutoRun, Story } from '../types'
import { controlTeam, type ChatTeam } from './chatTeams'
import {
  FOLLOWED,
  autoOutcome,
  followLeadAuto,
  freeBranch,
  leadAutoTask,
  newWorktreeSettings,
  savedAutoRun,
} from './leadAuto'

const saved = { task: 'wt', runId: 'run', story: 's1', branch: 'import' }
const run = (patch: Partial<AutoRun>) =>
  ({ runId: 'run', status: 'running', stage: 'implement', ...patch }) as AutoRun

test.each([
  [run({}), null],
  // Pauses that resume by themselves keep it running...
  [run({ status: 'paused', pauseKind: 'usage', resumeTrigger: { kind: 'usage', atMs: 1 } }), null],
  [
    run({ status: 'paused', pauseKind: 'scheduled', resumeTrigger: { kind: 'time', atMs: 1 } }),
    null,
  ],
  [run({ status: 'paused', pauseKind: 'restored', autonomous: true, restartPending: true }), null],
  // ...and every other pause waits on the user.
  [run({ status: 'paused', pauseKind: 'usage' }), 'failed'],
  [run({ status: 'paused', pauseKind: 'restored' }), 'failed'],
  [run({ status: 'paused', pauseKind: 'interrupted', reason: 'Resume retries' }), 'failed'],
  [run({ status: 'paused', pauseKind: 'inactive' }), 'failed'],
  [run({ status: 'done', stage: 'done' }), 'completed'],
  [run({ status: 'waitingOnYou', stage: 'mergeGate' }), 'completed'],
  [run({ status: 'waitingOnYou', waitingFor: 'agentInput', reason: 'Reviewer asks' }), 'failed'],
  [run({ status: 'paused', pauseKind: 'needsUser', reason: 'Branch changed' }), 'failed'],
  [run({ status: 'paused', pauseKind: 'user' }), 'failed'],
  [run({ status: 'failed', reason: 'Fix budget ran out' }), 'failed'],
  [run({ status: 'stopped' }), 'failed'],
  [run({ runId: 'other' }), 'failed'],
  [undefined, 'failed'],
] as const)('a lead Auto request settles for %j as %s', (current, state) => {
  expect(autoOutcome(current, saved, 'req')?.state ?? null).toBe(state)
})

test('settled outcomes name the story, its branch and what the lead may do', () => {
  expect(autoOutcome(run({ status: 'waitingOnYou', stage: 'mergeGate' }), saved, 'req')?.text).toBe(
    "Story s1 (worktree branch import) is reviewed and waiting for the user's merge approval. Don't merge it: the user approves merges.",
  )
  expect(
    autoOutcome(
      run({ status: 'paused', pauseKind: 'needsUser', reason: 'Approve npm test' }),
      saved,
      'req',
    )?.text,
  ).toContain('needs the user: Approve npm test')
  expect(
    autoOutcome(run({ status: 'failed', reason: 'Fix budget ran out' }), saved, 'req')?.text,
  ).toBe('Story s1 (worktree branch import) failed: Fix budget ran out.')
})

test('a new worktree gets a branch no other branch uses', () => {
  expect(freeBranch('import', ['main'])).toBe('import')
  expect(freeBranch('import', ['main', 'import', 'import-2'])).toBe('import-3')
})

test('newWorktree is true or an object of optional names', () => {
  expect(newWorktreeSettings(true)).toEqual({})
  expect(newWorktreeSettings({ branch: ' story/x ', base: 'main', extra: 1 })).toEqual({
    branch: 'story/x',
    base: 'main',
  })
  expect(newWorktreeSettings({ branch: '' })).toEqual({})
  for (const value of [undefined, false, 'yes', ['main']])
    expect(newWorktreeSettings(value)).toBeNull()
})

test('only a saved run with an identity is tracked', () => {
  expect(savedAutoRun(JSON.stringify({ task: null, runId: 'r' }))).toEqual({
    task: null,
    runId: 'r',
  })
  expect(savedAutoRun('Workflow control applied')).toBeNull()
  expect(savedAutoRun(JSON.stringify({ runId: 'r' }))).toBeNull()
  // A new worktree's run is saved before Auto starts there.
  expect(savedAutoRun(JSON.stringify({ task: 'wt', branch: 'b' }))).toEqual({
    task: 'wt',
    branch: 'b',
  })
  expect(savedAutoRun('null')).toBeNull()
})

test('a paused story tells the lead which request resumes it, and is followed', () => {
  const text = autoOutcome(run({ status: 'paused', pauseKind: 'user' }), saved, 'req')?.text
  expect(text).toContain('Use resumeAuto with {"request": "req"}')
  expect(text?.endsWith(FOLLOWED)).toBe(true)
  expect(autoOutcome(run({ status: 'done' }), saved, 'req')?.text.endsWith(FOLLOWED)).toBe(false)
  // Only a story's run is followed, so a run without one promises no note.
  const own = autoOutcome(
    run({ status: 'paused', pauseKind: 'user' }),
    { task: null, runId: 'run' },
    'req',
  )
  expect(own?.text).not.toContain(FOLLOWED)
  expect(
    autoOutcome(
      run({ status: 'paused', pauseKind: 'interrupted', reason: 'Resume retries' }),
      saved,
      'req',
    )?.text,
  ).toBe(
    `Story s1 (worktree branch import) needs the user: Resume retries. Its run continues once they act; don't retry it or answer for them. ${FOLLOWED}`,
  )
})

const story = (patch: Partial<Story>) => ({ id: 's1', task: 'wt', ...patch }) as Story
const team = (requests: ChatTeam['requests'], messages: ChatTeam['messages'] = []) =>
  ({ projectId: 'p', id: 't', task: 'lead', requests, messages }) as ChatTeam
const request = (patch: Partial<NonNullable<ChatTeam['requests']>[number]>) => ({
  id: 'req',
  action: 'startAuto' as const,
  settings: { story: 's1', newWorktree: true },
  state: 'running' as const,
  result: null,
  ...patch,
})
const project = (stories: Story[], auto?: AutoRun) =>
  vi.mocked(projectStateOf).mockReturnValue({
    stories,
    tasks: [{ id: 'wt', branch: 'import' }],
    taskWorkspaces: auto ? { wt: { auto } } : {},
  } as unknown as ReturnType<typeof projectStateOf>)

beforeEach(() => vi.mocked(controlTeam).mockReset())

test('pause, resume and stop find the worktree of the startAuto request they name', () => {
  project([story({})])
  const saved = JSON.stringify({ task: 'wt', runId: 'run' })
  expect(leadAutoTask(team([request({ result: saved })]), 'req')).toBe('wt')
  // Settled, its result is text: the story still names the worktree.
  expect(leadAutoTask(team([request({ state: 'failed', result: 'paused' })]), 'req')).toBe('wt')
  expect(leadAutoTask(team([request({ settings: {}, state: 'failed', result: 'x' })]), 'req')).toBe(
    'lead',
  )
  expect(() => leadAutoTask(team([]), 'req')).toThrow('Unknown startAuto request req')
})

test('a story that needed the user notes the lead once its run ends', async () => {
  const settled = request({
    state: 'failed',
    result: `Story s1 (worktree branch import) needs the user: x. ${FOLLOWED}`,
  })
  project([story({ autoRunId: 'run' })], run({ status: 'paused', pauseKind: 'needsUser' }))
  await followLeadAuto(team([settled]), settled)
  expect(controlTeam).not.toHaveBeenCalled()
  project([story({ autoRunId: 'run' })], run({ status: 'waitingOnYou', stage: 'mergeGate' }))
  await followLeadAuto(team([settled]), settled)
  expect(vi.mocked(controlTeam).mock.calls[0]?.[1]).toMatchObject({
    kind: 'note',
    id: 'auto-req',
    text: expect.stringContaining(
      "Update on workflow req: Story s1 (worktree branch import) is reviewed and waiting for the user's merge approval.",
    ),
  })
  // Once only, and never for a request that settled for good.
  vi.mocked(controlTeam).mockReset()
  await followLeadAuto(
    team([settled], [{ id: 'note-auto-req' } as ChatTeam['messages'][number]]),
    settled,
  )
  const failed = request({ state: 'failed', result: 'Story s1 failed: x.' })
  await followLeadAuto(team([failed]), failed)
  expect(controlTeam).not.toHaveBeenCalled()
})
