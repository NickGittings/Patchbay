import { beforeEach, expect, test, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn(async () => {}) }))
vi.mock('./ipc', () => ({
  sessionsList: vi.fn(),
  taskList: vi.fn(async () => []),
  gitBranches: vi.fn(async () => ['main', 'import']),
  gitWorktrees: vi.fn(async () => []),
}))
vi.mock('./auto', () => ({
  startAuto: vi.fn(),
  pauseAuto: vi.fn(),
  resumeAuto: vi.fn(),
  stopAuto: vi.fn(),
}))
vi.mock('./leadStages', () => ({ startLeadStage: vi.fn(), settleLeadStage: vi.fn() }))
vi.mock('./stories', () => ({
  findStory: vi.fn(async (_project: string, id: string) => ({
    id,
    title: 'Import',
    components: [],
  })),
  storyGoal: vi.fn(() => 'Import\n\n- [ ] Works'),
  linkAutoStory: vi.fn(async () => {}),
  updateStory: vi.fn(async () => {}),
  descendants: vi.fn(() => []),
}))
// The real module loads the board's own code; only the default merge destination is needed.
vi.mock('./reviewAgents', () => ({
  defaultMergeDestination: vi.fn((_source: unknown, _worktrees: unknown, branches?: string[]) =>
    branches?.includes('main') ? 'main' : '',
  ),
}))
vi.mock('./tasks', () => ({
  branchFor: vi.fn((title: string) => title.toLowerCase()),
  createBackgroundTask: vi.fn(async () => ({ id: 'wt', worktree: '/p-import-2' })),
}))
import { startAuto, pauseAuto } from './auto'
import { settleLeadStage, startLeadStage } from './leadStages'
import { invoke } from '@tauri-apps/api/core'
import { taskList } from './ipc'
import { useStore, workspaceOf } from '../store'
import { useSimpleUi, simpleKey } from './simpleUi'
import { clearSimpleChat } from './simpleActions'
import { restoredSimple } from './simple'
import {
  applyTeamHandoff,
  continueChat,
  continuationContext,
  cacheTeam,
  completeTeamTask,
  initializeTeam,
  leadDeliveryPending,
  leadNotes,
  settleLeadNotes,
  refreshChatTeams,
  resetLead,
  sendWorkerMessage,
  useChatTeams,
  type ChatTeam,
  type TeamControl,
} from './chatTeams'
import {
  WORKTREE_BUSY,
  type AutoRun,
  type SessionRecord,
  type Story,
  type Task,
  type WorkflowAction,
} from '../types'
const preset = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  kind: 'agent' as const,
  adapter: 'codex' as const,
}
const team = (patch: Partial<ChatTeam> = {}): ChatTeam => ({
  id: 'team',
  projectId: 'p',
  task: null,
  target: '/p',
  lead: { sessionId: 'lead', generation: 1, conversation: 'conversation', preset },
  state: 'running',
  workers: [preset],
  limit: 2,
  rounds: [],
  checkpoint: {
    goal: 'Goal',
    constraints: 'Keep edits',
    decisions: '',
    remaining: 'Verify',
    validation: 'Pending',
  },
  messages: [],
  reset: null,
  handoff: null,
  error: null,
  ...patch,
})
const record: SessionRecord = {
  id: 'lead',
  metadata: {
    projectId: 'p',
    projectRoot: '/p',
    projectName: 'P',
    componentId: '@task',
    terminalId: 'lead',
    name: 'Codex',
    kind: 'agent',
    adapter: 'codex',
    conversationId: 'conversation',
    command: 'codex',
  },
  spec: { cwd: '/p', command: 'codex' },
  snapshot: null,
  history: [],
  interrupted: false,
}
beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject({
    projectId: 'p',
    name: 'P',
    root: '/p',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  useStore.getState().patchTask('p', null, {
    simple: {
      startedMs: 1,
      selectedAgent: 'lead',
      log: [
        {
          id: 'user',
          atMs: 2,
          stage: 'build',
          kind: 'prompt',
          sessionId: 'lead',
          text: 'Retain my changes',
          mentions: [],
        },
      ],
    },
  })
  useSimpleUi.setState({ worktrees: {} })
  useChatTeams.setState({ teams: {}, runs: {} })
})
test('migration keeps the selected lead and visible history and initializes paused', async () => {
  useStore.setState({ sessionRecords: [record] })
  vi.mocked(invoke).mockImplementation(
    async (cmd) => (cmd === 'chat_teams' ? [] : team({ state: 'paused' })) as never,
  )
  await refreshChatTeams('p')
  const initialize = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'chat_team_initialize')
  expect(initialize?.[1]).toMatchObject({
    projectId: 'p',
    seed: { sessionId: 'lead', paused: true, checkpoint: { goal: 'Retain my changes' } },
  })
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useStore.getState().simple?.selectedAgent).toBe('lead')
  expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'provider_job_start')).toBe(false)
})
test('fresh conversation queues a durable reset and keeps history until confirmation', async () => {
  const reset = team({
    reset: { id: 'reset', nextSession: 'lead', phase: 'queued', clearHistory: true, error: null },
  })
  vi.mocked(invoke).mockResolvedValue(reset)
  await resetLead(team())
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_control',
    expect.objectContaining({
      control: expect.objectContaining({ kind: 'reset', session: 'lead', clearHistory: true }),
    }),
  )
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)].coordinationReset).toBe(true)
})
const answerTeams = (teams: ChatTeam[]) =>
  vi
    .mocked(invoke)
    .mockImplementation(async (command) => (command === 'chat_teams' ? teams : teams[0]))
test('a completed task reads durable teams, so an unloaded cache cannot skip it', async () => {
  useChatTeams.setState({ teams: {}, runs: {} })
  vi.mocked(invoke).mockClear()
  answerTeams([team()])
  await completeTeamTask('p', null, 'task-done-merge', 42)
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_control',
    expect.objectContaining({
      control: { kind: 'completeTask', id: 'task-done-merge', sinceMs: 42 },
    }),
  )
})
test('a completed task leaves stopped teams alone', async () => {
  vi.mocked(invoke).mockClear()
  answerTeams([team({ state: 'stopped' })])
  await completeTeamTask('p', null, 'task-done-merge')
  expect(invoke).not.toHaveBeenCalledWith('chat_team_control', expect.anything())
})
test('a rejected reset releases the composer', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Auto or another owner controls'))
  await expect(resetLead(team())).rejects.toThrow('another owner')
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)].coordinationReset).toBe(false)
})
test('a completed task hands off without repeating the finished work', async () => {
  useChatTeams.setState({ teams: { p: [] }, runs: {} })
  vi.mocked(invoke).mockResolvedValue(team())
  await applyTeamHandoff(
    team({
      handoff: {
        id: 'task-done-merge',
        sessionId: 'lead',
        generation: 2,
        text: 'Goal: old work',
        clearHistory: true,
        completeTask: true,
      },
    }),
  )
  const texts = useStore.getState().simple?.log.map((e) => e.text)
  expect(texts).toContain('Task complete. New lead conversation.')
  expect(texts?.join('\n')).not.toContain('old work')
})
test('failed fresh reset retains the saved conversation and workers', async () => {
  const current = team()
  useChatTeams.setState({ teams: { p: [current] }, runs: {} })
  const history = useStore.getState().simple
  vi.mocked(invoke).mockRejectedValue(new Error('Reset could not be saved'))
  await expect(resetLead(current)).rejects.toThrow('Reset could not be saved')
  expect(useStore.getState().simple).toEqual(history)
  expect(useChatTeams.getState().teams.p[0].workers).toEqual(current.workers)
})
test('a confirmed replacement clears once, retains a handoff and keeps clear reply boundaries after restore', async () => {
  const confirmed = team({
    lead: { ...team().lead, generation: 2 },
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      text: 'Goal and validation retained',
      clearHistory: true,
    },
  })
  useStore.getState().setSession('lead', {
    generation: 1,
    running: true,
    replies: [{ sequence: 8, atMs: 4, text: 'old reply', turn: null }],
  })
  vi.mocked(invoke).mockResolvedValue(team({ lead: confirmed.lead }))
  await applyTeamHandoff(confirmed)
  const simple = useStore.getState().simple!
  expect(simple.log).toHaveLength(1)
  expect(simple.log[0].text).toContain('Goal and validation retained')
  expect(simple.coordinationHandoff).toBe('reset')
  expect(simple.clearBoundary?.runs).toContainEqual({
    sessionId: 'lead',
    generation: 1,
    sequence: 8,
  })
  useStore.getState().patchTask('p', null, { simple: restoredSimple(simple) })
  await applyTeamHandoff(confirmed)
  expect(useStore.getState().simple?.log).toEqual(simple.log)
})
test('handoffs apply to their own background worktree without clearing another worktree', async () => {
  useStore.getState().patchTask('p', 'worker-task', {
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'background',
          atMs: 2,
          kind: 'prompt',
          stage: 'build',
          text: 'Background goal',
          mentions: [],
        },
      ],
    },
  })
  const main = useStore.getState().simple
  const background = team({
    task: 'worker-task',
    handoff: {
      id: 'reset',
      sessionId: 'other-lead',
      generation: 3,
      text: 'Background handoff',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockResolvedValue({ ...background, handoff: null })
  await applyTeamHandoff(background)
  expect(useStore.getState().simple).toEqual(main)
  expect(workspaceOf(useStore.getState(), 'worker-task').simple?.selectedAgent).toBe('other-lead')
  expect(workspaceOf(useStore.getState(), 'worker-task').simple?.log[0].text).toContain(
    'Background handoff',
  )
})
test('clear chat leaves coordination, provider and worker state untouched', () => {
  const current = cacheTeam(team())
  expect(clearSimpleChat('p', null)).toBe(true)
  expect(useChatTeams.getState().teams.p).toEqual([current])
  expect(useStore.getState().simple?.selectedAgent).toBe('lead')
  expect(invoke).not.toHaveBeenCalled()
})
test('failed handoff acknowledgement does not clear newly arrived visible history on retry', async () => {
  const confirmed = team({
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      text: 'Retained goal',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue(team())
  await expect(applyTeamHandoff(confirmed)).rejects.toThrow('lost reply')
  const simple = useStore.getState().simple!
  useStore.getState().patchTask('p', null, {
    simple: {
      ...simple,
      log: [
        ...simple.log,
        {
          id: 'new',
          atMs: Date.now() + 1,
          kind: 'prompt',
          stage: 'build',
          text: 'new user message',
          mentions: [],
        },
      ],
    },
  })
  await applyTeamHandoff(confirmed)
  expect(useStore.getState().simple?.log.at(-1)?.text).toBe('new user message')
})
test('a waiting note rides the user’s prompt to the lead and never holds it', async () => {
  const message = { sequence: 1, sender: 'patchbay', recipient: 'lead', assignment: null }
  const note = { ...message, id: 'note-1', text: 'The user started a merge.', generation: null }
  cacheTeam(team({ messages: [{ ...note, state: 'pending', passive: true }] }))
  expect(leadDeliveryPending('p', null, 'lead', 1)).toBe(false)
  // Another session is not the lead, so it carries nothing.
  expect(leadNotes('p', null, 'worker').text).toBe('')
  const notes = leadNotes('p', null, 'lead')
  expect(notes.text).toBe('[Patchbay note, no reply needed]\nThe user started a merge.')
  vi.mocked(invoke).mockResolvedValue(team())
  await settleLeadNotes('p', null, notes.ids)
  expect(invoke).toHaveBeenCalledWith('chat_team_control', {
    projectId: 'p',
    id: 'team',
    control: { kind: 'notesDelivered', ids: ['note-1'] },
  })
  // An ordinary undelivered message still holds the prompt.
  cacheTeam(team({ messages: [{ ...note, state: 'pending' }] }))
  expect(leadDeliveryPending('p', null, 'lead', 1)).toBe(true)
})
test('messages held for a limit-stopped lead never hold the user’s prompt', () => {
  const message = {
    id: 'held',
    sequence: 1,
    sender: 'worker',
    recipient: 'lead',
    assignment: null,
    text: 'Done',
    generation: null,
  }
  cacheTeam(team({ recovery: true, messages: [{ ...message, state: 'pending' }] }))
  expect(leadDeliveryPending('p', null, 'lead', 1)).toBe(true)
  useStore.setState({
    sessions: {
      lead: { status: { agent: { state: 'idle', sinceMs: 5, limitStoppedMs: 5 } } },
    } as never,
  })
  expect(leadDeliveryPending('p', null, 'lead', 1)).toBe(false)
  // A write already under way still owns the prompt.
  cacheTeam(team({ messages: [{ ...message, state: 'sending' }] }))
  expect(leadDeliveryPending('p', null, 'lead', 1)).toBe(true)
})
test('side messages address the stored team and assignment and preserve their text', async () => {
  vi.mocked(invoke).mockResolvedValue(team())
  await sendWorkerMessage(team(), 'assignment-a', 'Check this constraint')
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_message',
    expect.objectContaining({
      projectId: 'p',
      id: 'team',
      assignment: 'assignment-a',
      text: 'Check this constraint',
      messageId: expect.any(String),
    }),
  )
})
test('initializing the selected lead uses its authenticated preset rather than injected briefing arguments', async () => {
  vi.mocked(invoke).mockResolvedValue(team())
  await initializeTeam('p', null, {
    ...record,
    spec: { cwd: '/p', command: 'codex --injected-briefing' },
  })
  expect(invoke).toHaveBeenCalledWith(
    'chat_team_initialize',
    expect.objectContaining({
      seed: expect.objectContaining({ preset: expect.objectContaining({ command: 'codex' }) }),
    }),
  )
})

test('initializing a lead syncs the enabled sub-builder role before returning', async () => {
  useStore.getState().setAgentRoles({ worker: [preset.id] })
  const initialized = team()
  const synced = team({ agentRoles: { worker: [preset.id] } })
  vi.mocked(invoke).mockResolvedValueOnce(initialized).mockResolvedValueOnce(synced)

  await expect(initializeTeam('p', null, record)).resolves.toEqual(synced)
  expect(invoke).toHaveBeenNthCalledWith(
    2,
    'chat_team_control',
    expect.objectContaining({
      control: expect.objectContaining({ kind: 'catalog', roles: { worker: [preset.id] } }),
    }),
  )
})

test('a reply from the replacement that arrives before handoff acknowledgement stays visible', async () => {
  const original = useStore.getState().simple!
  useStore.getState().patchTask('p', null, {
    simple: {
      ...original,
      log: [
        ...original.log,
        {
          id: 'new-reply',
          atMs: 110,
          kind: 'reply',
          stage: 'build',
          sessionId: 'lead',
          generation: 2,
          sequence: 1,
          text: 'Fresh conversation reply',
        },
      ],
    },
  })
  useStore.getState().setSession('lead', {
    generation: 2,
    running: true,
    replies: [{ sequence: 1, atMs: 110, text: 'Fresh conversation reply', turn: null }],
  })
  const confirmed = team({
    handoff: {
      id: 'reset',
      sessionId: 'lead',
      generation: 2,
      startedMs: 100,
      text: 'Retained handoff',
      clearHistory: true,
    },
  })
  vi.mocked(invoke).mockResolvedValue({ ...confirmed, handoff: null })
  await applyTeamHandoff(confirmed)
  const simple = useStore.getState().simple!
  expect(simple.log.map((entry) => entry.text)).toEqual([
    expect.stringContaining('Retained handoff'),
    'Fresh conversation reply',
  ])
  expect(simple.clearBoundary?.runs.some((r) => r.sessionId === 'lead' && r.generation === 2)).toBe(
    false,
  )
})

test('a side-message RPC with an uncertain reply retries the same durable identity', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue(team())
  await expect(
    sendWorkerMessage(team(), 'unique-retry-worker', 'Keep this message once'),
  ).rejects.toThrow('reply lost')
  await sendWorkerMessage(team(), 'unique-retry-worker', 'Keep this message once')
  const messages = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === 'chat_team_message')
  expect(messages[0][1]).toEqual(messages[1][1])
})

function mockRequestDriver(action: WorkflowAction, settings = {}) {
  const saved = team({
    requests: [{ id: 'request', action, settings, state: 'queued', result: null }],
  })
  vi.mocked(invoke).mockImplementation(async (cmd, args) => {
    if (cmd === 'chat_teams') return [saved] as never
    if (cmd === 'chat_team_control') {
      const { control } = args as { control: TeamControl }
      if (control.kind === 'requestState') {
        const request = saved.requests![0]
        if (control.state === 'starting' && !['queued', 'waiting'].includes(request.state))
          throw new Error('Already claimed')
        request.state = control.state
        request.result = control.result
      }
    }
    return saved as never
  })
  return saved
}
/** The mocked Auto start records a run, as the real one does. */
function startsRun() {
  vi.mocked(startAuto).mockImplementation(async (projectId, task) => {
    useStore.getState().patchTask(projectId, task, {
      auto: { runId: 'run', status: 'running', stage: 'plan' } as AutoRun,
    })
  })
}
test('lead workflow controls claim requests once before applying the existing Auto handler', async () => {
  const saved = mockRequestDriver('pauseAuto')
  await Promise.all([refreshChatTeams('p'), refreshChatTeams('p')])
  expect(pauseAuto).toHaveBeenCalledExactlyOnceWith('p', null)
  expect(saved.requests![0].state).toBe('completed')
})
test.each(['startPlan', 'startBuild', 'startFix', 'startMerge'] satisfies WorkflowAction[])(
  '%s runs its stage for the team once',
  async (action) => {
    const saved = mockRequestDriver(action)
    await Promise.all([refreshChatTeams('p'), refreshChatTeams('p')])
    expect(startLeadStage).toHaveBeenCalledOnce()
    expect(saved.requests![0].state).toBe('starting')
  },
)
test.each([undefined, { worker: [] }, { worker: ['uninstalled'] }])(
  'startAgent fails before delegating with sub-builder roles %j',
  async (roles) => {
    const saved = mockRequestDriver('startAgent', { preset: preset.id, instructions: 'Inspect' })
    saved.agentRoles = roles
    await refreshChatTeams('p')
    expect(saved.requests![0]).toMatchObject({
      state: 'failed',
      result:
        'Sub-builders are off (Settings → Agent roles → Sub-builders). Use a stage such as startPlan, startBuild or startAuto, or ask the user to turn sub-builders on.',
    })
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toContain(
      'chat_team_delegate_shared',
    )
  },
)

test('a running lead stage is checked for its agent finishing', async () => {
  const saved = mockRequestDriver('startBuild')
  saved.requests![0].state = 'running'
  vi.mocked(settleLeadStage).mockResolvedValueOnce(undefined)
  await refreshChatTeams('p')
  expect(settleLeadStage).toHaveBeenCalledOnce()
  expect(startLeadStage).not.toHaveBeenCalled()
})
test('a queued request in a worktree the store has not loaded yet starts there', async () => {
  const saved = mockRequestDriver('startBuild', { worktree: 'w2' })
  vi.mocked(taskList).mockResolvedValueOnce([
    { id: 'w2', worktree: '/p-w2', missing: false } as Task,
  ])
  await refreshChatTeams('p')
  expect(startLeadStage).toHaveBeenCalledOnce()
  expect(vi.mocked(startLeadStage).mock.calls[0][0]).toMatchObject({ task: 'w2', target: '/p-w2' })
  expect(saved.requests![0].state).toBe('starting')
})
test('a queued request waits while the worktree list cannot be read, and fails once it is gone', async () => {
  const saved = mockRequestDriver('startBuild', { worktree: 'gone' })
  vi.mocked(taskList).mockRejectedValueOnce(new Error('offline'))
  await refreshChatTeams('p')
  expect(saved.requests![0].state).toBe('queued')
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({ state: 'failed' })
  expect(saved.requests![0].result).toContain('Worktree gone is no longer open')
  expect(startLeadStage).not.toHaveBeenCalled()
})
test('a lead stage refused by a worktree owner fails instead of repeating its handoff', async () => {
  const saved = mockRequestDriver('startBuild')
  vi.mocked(startLeadStage).mockRejectedValueOnce(new Error('This worktree is controlled by Auto'))
  await refreshChatTeams('p')
  expect(saved.requests![0].state).toBe('failed')
})
test('a lead stage refused by a merge agent asks the lead to check with the user', async () => {
  const saved = mockRequestDriver('startBuild')
  vi.mocked(startLeadStage).mockRejectedValueOnce(
    new Error(`${WORKTREE_BUSY} by “Merge feature → main”; stop it there first`),
  )
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'failed',
    result: expect.stringContaining('Ask the user whether to stop that merge agent'),
  })
})
test('a lead stage that cannot start reports why', async () => {
  const saved = mockRequestDriver('startFix')
  vi.mocked(startLeadStage).mockRejectedValueOnce(new Error('Review this worktree first'))
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'failed',
    result: expect.stringContaining('Review this worktree first'),
  })
})
test('an overlapping Auto start remains waiting and can be retried after scope release', async () => {
  const saved = mockRequestDriver('startAuto', { goal: 'New task' })
  startsRun()
  vi.mocked(startAuto).mockRejectedValueOnce(
    new Error('An unfinished provider run controls this worktree'),
  )
  await refreshChatTeams('p')
  expect(saved.requests![0].state).toBe('waiting')
  await refreshChatTeams('p')
  expect(saved.requests![0].state).toBe('running')
  expect(startAuto).toHaveBeenLastCalledWith(
    'p',
    null,
    expect.objectContaining({ goal: 'New task', merge: { mode: 'ask', destinationBranch: '' } }),
  )
})

test.each([
  [false, undefined, undefined, 'standard'],
  [true, undefined, undefined, 'light'],
  [false, 'implement', 'light', 'light'],
] as const)(
  'lead Auto starts use matching defaults and honor explicit settings (Simple %s, stage %s, effort %s)',
  async (simpleMode, stage, effort, expectedEffort) => {
    const previous: AutoRun = {
      goal: 'Old task',
      effort: 'thorough',
      device: 'old-device',
      merge: { mode: 'ask', destinationBranch: 'main' },
      agents: { plan: 'planner' },
      reviewers: ['reviewer'],
      scanners: ['scanner'],
      workers: ['worker'],
      overrides: { maxRounds: 4, severityFloor: 'low', validate: true },
      autonomous: true,
      background: true,
      resumeOnUsageReset: true,
      runId: 'old-run',
      ownershipId: 'old-owner',
      stage: 'done',
      status: 'done',
      round: 3,
      sessionId: 'old-session',
      sessionRequestId: 'old-request',
      implementationRun: 'old-build',
      implementationLaunch: 'old-launch',
      scanRound: 'old-scan',
      log: [{ atMs: 1, text: 'Old log' }],
    }
    useStore.setState({ simpleMode })
    useStore.getState().patchTask('p', null, { auto: previous })
    startsRun()
    const saved = mockRequestDriver('startAuto', {
      ...(effort ? { effort } : {}),
      ...(stage ? { stage } : {}),
    })
    await refreshChatTeams('p')
    expect(saved.requests![0].state).toBe('running')
    expect(startAuto).toHaveBeenCalledExactlyOnceWith('p', null, {
      goal: 'Goal',
      effort: expectedEffort,
      device: 'codex',
      merge: previous.merge,
      agents: previous.agents,
      reviewers: previous.reviewers,
      scanners: previous.scanners,
      workers: previous.workers,
      overrides: simpleMode ? { maxRounds: 4 } : previous.overrides,
      autonomous: true,
      background: true,
      resumeOnUsageReset: true,
      ...(stage ? { stage } : {}),
    })
  },
)

test('a lead Auto start for a story uses its text as the goal and links it once started', async () => {
  const stories = await import('./stories')
  const saved = mockRequestDriver('startAuto', { story: 's1', goal: 'Something else' })
  startsRun()
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'running',
    result: JSON.stringify({ task: null, runId: 'run', story: 's1' }),
  })
  const settings = vi.mocked(startAuto).mock.calls[0][2]
  expect(settings.goal).toBe('Import\n\n- [ ] Works')
  expect(settings).not.toHaveProperty('story')
  expect(stories.linkAutoStory).toHaveBeenCalledExactlyOnceWith('p', null, 's1')
  expect(vi.mocked(startAuto).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(stories.linkAutoStory).mock.invocationCallOrder[0],
  )
})

test('a lead Auto start in a new worktree creates it in the background and links its story first', async () => {
  const stories = await import('./stories')
  const tasks = await import('./tasks')
  const saved = mockRequestDriver('startAuto', {
    story: 's1',
    newWorktree: true,
    merge: { mode: 'ask', destinationBranch: 'main' },
    autonomous: false,
    background: false,
  })
  startsRun()
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].result).toContain('runId'))
  // Saved before Auto starts, so a restart during the worktree's setup reuses the worktree.
  const results = vi
    .mocked(invoke)
    .mock.calls.flatMap(([cmd, args]) =>
      cmd === 'chat_team_control' ? [(args as { control: TeamControl }).control] : [],
    )
  expect(results).toContainEqual({
    kind: 'requestState',
    id: 'request',
    state: 'running',
    result: JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2' }),
  })
  expect(tasks.createBackgroundTask).toHaveBeenCalledExactlyOnceWith('p', {
    title: 'Import',
    branch: 'import-2',
    base: 'main',
    components: [],
  })
  expect(stories.updateStory).toHaveBeenCalledExactlyOnceWith('p', 's1', { task: 'wt' })
  const settings = vi.mocked(startAuto).mock.calls[0][2]
  expect(vi.mocked(startAuto).mock.calls[0][1]).toBe('wt')
  // The lead may turn autonomy off, but a run beside the user's screen keeps driving.
  expect(settings).toMatchObject({ autonomous: false, background: true, resumeOnUsageReset: true })
  expect(settings).not.toHaveProperty('newWorktree')
  expect(stories.linkAutoStory).toHaveBeenCalledExactlyOnceWith('p', 'wt', 's1')
  expect(saved.requests![0]).toMatchObject({
    state: 'running',
    result: JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2', runId: 'run' }),
  })
})

test("a new worktree starts from the merge defaults, not the lead worktree's last run", async () => {
  const tasks = await import('./tasks')
  useStore.getState().patchTask('p', null, {
    auto: {
      runId: 'old',
      status: 'done',
      stage: 'done',
      merge: { mode: 'auto', destinationBranch: 'release' },
    } as AutoRun,
  })
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  startsRun()
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].result).toContain('runId'))
  // It starts where its run will merge, the local main, not the checkout's open HEAD.
  expect(vi.mocked(tasks.createBackgroundTask).mock.calls[0]?.[1].base).toBe('main')
  expect(vi.mocked(startAuto).mock.calls[0][2].merge).toEqual({
    mode: 'ask',
    destinationBranch: '',
  })
})

test('a story whose Auto does not start in its new worktree fails once and returns to the backlog', async () => {
  const stories = await import('./stories')
  const tasks = await import('./tasks')
  useStore.setState({ stories: [{ id: 's1', task: 'wt' } as Story] })
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  vi.mocked(startAuto).mockRejectedValue(new Error('This worktree is controlled by another run'))
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].state).toBe('failed'))
  expect(saved.requests![0].result).toContain(
    'Worktree branch import-2 was created for story s1, but Auto did not start',
  )
  expect(stories.updateStory).toHaveBeenLastCalledWith('p', 's1', { task: '' })
  // An ownership error never makes it wait for a retry that would create another worktree.
  await refreshChatTeams('p')
  expect(tasks.createBackgroundTask).toHaveBeenCalledOnce()
})

test('a worktree creation failure is never retried', async () => {
  const tasks = await import('./tasks')
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  vi.mocked(tasks.createBackgroundTask).mockRejectedValue(
    new Error('An unfinished provider run controls this worktree'),
  )
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].state).toBe('failed'))
  expect(saved.requests![0].result).toContain("Story s1's worktree could not be created")
  await refreshChatTeams('p')
  expect(tasks.createBackgroundTask).toHaveBeenCalledOnce()
})

test('a story the board could not link to its new worktree fails, naming the branch', async () => {
  const stories = await import('./stories')
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  vi.mocked(stories.updateStory).mockRejectedValue(new Error('store locked'))
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].state).toBe('failed'))
  expect(saved.requests![0]).toMatchObject({
    state: 'failed',
    result: expect.stringContaining(
      'Worktree branch import-2 was created for story s1, but the story could not be linked',
    ),
  })
  expect(startAuto).not.toHaveBeenCalled()
})

test('a new worktree start interrupted by a restart starts again in the same worktree', async () => {
  const tasks = await import('./tasks')
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  saved.requests![0].state = 'running'
  saved.requests![0].result = JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2' })
  startsRun()
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].result).toContain('"runId":"run"'))
  expect(vi.mocked(startAuto).mock.calls[0][1]).toBe('wt')
  expect(tasks.createBackgroundTask).not.toHaveBeenCalled()
})

test('a restart before the worktree was saved reuses the worktree made for its branch', async () => {
  const tasks = await import('./tasks')
  useStore.setState({ tasks: [{ id: 'wt', branch: 'import-2' } as Task] })
  // The project checkout's own run is not this request's.
  useStore.getState().patchTask('p', null, {
    auto: { runId: 'mine', status: 'running', stage: 'plan' } as AutoRun,
  })
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  saved.requests![0].state = 'running'
  saved.requests![0].result = JSON.stringify({ task: null, story: 's1', branch: 'import-2' })
  startsRun()
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].result).toContain('"runId":"run"'))
  expect(tasks.createBackgroundTask).not.toHaveBeenCalled()
  expect(vi.mocked(startAuto).mock.calls[0][1]).toBe('wt')
})

test('a story whose Auto settings fail in the background still returns to the backlog', async () => {
  const stories = await import('./stories')
  useStore.setState({ stories: [{ id: 's1', task: 'wt' } as Story] })
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  saved.requests![0].state = 'running'
  saved.requests![0].result = JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2' })
  vi.mocked(stories.findStory).mockRejectedValue(new Error('Unknown story s1'))
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(saved.requests![0].state).toBe('failed'))
  expect(stories.updateStory).toHaveBeenLastCalledWith('p', 's1', { task: '' })
  expect(saved.requests![0].result).toContain('The story is in the backlog again')
})

test('a story started while another worktree is still being created gets its own branch', async () => {
  const tasks = await import('./tasks')
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  // The first worktree is still being created, so git doesn't list its branch yet.
  let finishFirst = () => {}
  vi.mocked(tasks.createBackgroundTask).mockReturnValueOnce(
    new Promise((resolve) => {
      finishFirst = () => resolve({ id: 'wt' } as Task)
    }),
  )
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(tasks.createBackgroundTask).toHaveBeenCalledOnce())
  saved.requests![0] = {
    id: 'second',
    action: 'startAuto',
    settings: { story: 's2', newWorktree: true },
    state: 'queued',
    result: null,
  }
  startsRun()
  await refreshChatTeams('p')
  await vi.waitFor(() => expect(tasks.createBackgroundTask).toHaveBeenCalledTimes(2))
  expect(vi.mocked(tasks.createBackgroundTask).mock.calls.map(([, d]) => d.branch)).toEqual([
    'import-2',
    'import-3',
  ])
  finishFirst()
  await vi.waitFor(() => expect(startAuto).toHaveBeenCalledTimes(2))
})

test('a started run whose id was not saved is adopted instead of failing', async () => {
  const saved = mockRequestDriver('startAuto', { story: 's1', newWorktree: true })
  saved.requests![0].state = 'running'
  saved.requests![0].result = JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2' })
  useStore.getState().patchTask('p', 'wt', {
    auto: { runId: 'run', status: 'running', stage: 'plan' } as AutoRun,
  })
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'running',
    result: JSON.stringify({ task: 'wt', story: 's1', branch: 'import-2', runId: 'run' }),
  })
  expect(startAuto).not.toHaveBeenCalled()
})

test('pause controls the run of the startAuto request it names', async () => {
  const saved = mockRequestDriver('pauseAuto', { request: 'story-run' })
  saved.requests!.push({
    id: 'story-run',
    action: 'startAuto',
    settings: { story: 's1', newWorktree: true },
    state: 'running',
    result: JSON.stringify({ task: 'wt', runId: 'run', story: 's1' }),
  })
  await refreshChatTeams('p')
  expect(pauseAuto).toHaveBeenCalledExactlyOnceWith('p', 'wt')
})

test('a new worktree needs a story', async () => {
  const tasks = await import('./tasks')
  const saved = mockRequestDriver('startAuto', { newWorktree: true })
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'failed',
    result: expect.stringContaining('newWorktree needs a story'),
  })
  expect(tasks.createBackgroundTask).not.toHaveBeenCalled()
})

test('a running lead Auto request settles once its run waits for merge approval', async () => {
  const saved = mockRequestDriver('startAuto', { story: 's1' })
  saved.requests![0].state = 'running'
  saved.requests![0].result = JSON.stringify({ task: null, runId: 'run', story: 's1' })
  useStore.getState().patchTask('p', null, {
    auto: { runId: 'run', status: 'running', stage: 'review' } as AutoRun,
  })
  await refreshChatTeams('p')
  expect(saved.requests![0].state).toBe('running')
  useStore.getState().patchTask('p', null, {
    auto: { runId: 'run', status: 'waitingOnYou', stage: 'mergeGate' } as AutoRun,
  })
  await refreshChatTeams('p')
  expect(saved.requests![0]).toMatchObject({
    state: 'completed',
    result: expect.stringContaining('waiting for the user'),
  })
  expect(startAuto).not.toHaveBeenCalled()
})

test('live continuation resolves the durable lead once and keeps the transcript and draft', async () => {
  const saved = team()
  cacheTeam(saved)
  useStore.setState({ sessions: { lead: { running: true, generation: 1 } } })
  useSimpleUi.getState().patch(simpleKey('p', null), { draft: 'Pending question' })
  vi.mocked(invoke).mockResolvedValue({
    session: record,
    generation: 1,
    outcome: 'connected',
    team: saved,
  })
  const first = continueChat(saved)
  const second = continueChat(saved)
  expect(first).toBe(second)
  await first
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'chat_continue',
    expect.objectContaining({
      id: 'team',
      projectId: 'p',
      savedContext: expect.stringContaining('Retain my changes'),
    }),
  )
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)]).toMatchObject({
    draft: 'Pending question',
    connection: undefined,
  })
})

test('reconstruction adds a small notice once without clearing earlier messages', async () => {
  const original = useStore.getState().simple!
  const reconstructed = team({
    handoff: {
      id: 'automatic-recovery',
      sessionId: 'lead',
      generation: 2,
      startedMs: 100,
      text: 'Private coordination details',
      clearHistory: false,
    },
  })
  vi.mocked(invoke).mockResolvedValue({ ...reconstructed, handoff: null })
  await applyTeamHandoff(reconstructed)
  await applyTeamHandoff(reconstructed)
  expect(useStore.getState().simple?.log.map((e) => e.text)).toEqual([
    original.log[0].text,
    'Context restored from the saved conversation and team state.',
  ])
  expect(useStore.getState().simple?.clearBoundary).toBeUndefined()
})

test('continuation context honors visible-history clearing and excludes retained workflow text', () => {
  const original = useStore.getState().simple!
  useStore.getState().patchTask('p', null, {
    simple: {
      ...original,
      clearBoundary: { atMs: 10, runs: [] },
      retainedWorkflow: original.log,
      log: [...original.log, { ...original.log[0], id: 'fresh', atMs: 11, text: 'New request' }],
    },
  })
  const text = continuationContext('p', null)
  expect(text).toContain('New request')
  expect(text).not.toContain('Retain my changes')
})

test('structured access failures keep the selected lead, transcript and pending draft', async () => {
  const saved = team()
  cacheTeam(saved)
  useStore.setState({ sessions: { lead: { running: true, generation: 1 } } })
  useSimpleUi.getState().patch(simpleKey('p', null), { draft: 'Keep this draft' })
  vi.mocked(invoke).mockRejectedValue({
    kind: 'access',
    message: 'Allow the locked project folder',
  })
  await expect(continueChat(saved)).rejects.toMatchObject({
    kind: 'access',
    message: 'Allow the locked project folder',
  })
  expect(useStore.getState().simple?.selectedAgent).toBe('lead')
  expect(useStore.getState().simple?.log[0].text).toBe('Retain my changes')
  expect(useSimpleUi.getState().worktrees[simpleKey('p', null)]).toMatchObject({
    draft: 'Keep this draft',
    connection: undefined,
  })
})
