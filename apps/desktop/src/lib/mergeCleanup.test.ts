import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  cleanupJobs,
  completeMergeChat,
  completeTaskContext,
  deleteMergedWork,
  finishCleanup,
  handledCleanup,
  readyCleanup,
  trackMergeCleanup,
} from './mergeCleanup'
import { gitWorktrees, mergeCleanup, mergeCleanupPreview, mergeOutcome, terminalStop } from './ipc'
import { completeTeamTask, forgetTeamChat } from './chatTeams'
import { forgetMainWorktree, refreshMainWorktree, useMainWorktree } from './mainWorktree'
import { refreshTasks } from './tasks'
import type { Project, SessionRecord, SessionState, Task } from '../types'
import { restoredSimple, visibleReply, type SimpleState } from './simple'
import { simpleKey, useSimpleUi } from './simpleUi'

vi.mock('./ipc', () => ({
  mergeOutcome: vi.fn(),
  mergeCleanup: vi.fn(),
  mergeCleanupPreview: vi.fn(),
  gitWorktrees: vi.fn(),
  terminalStop: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./chatTeams', () => ({
  completeTeamTask: vi.fn().mockResolvedValue(undefined),
  forgetTeamChat: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('./sessions', () => ({ reconcileFreshSessions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./tasks', () => ({ refreshTasks: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn().mockResolvedValue(undefined) }))

const project: Project = {
  schemaVersion: 4,
  projectId: 'p',
  name: 'P',
  root: '/p',
  components: [],
  links: [],
  groups: [],
}
const request = {
  source: '/feature',
  sourceBranch: 'feature',
  destination: '/p',
  destinationBranch: 'main',
}
beforeEach(() => {
  forgetMainWorktree('p')
  vi.mocked(gitWorktrees).mockReset()
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject(project)
  useStore.setState({ workspaceSettings: {}, sessions: {}, sessionRecords: [] })
  vi.mocked(mergeCleanupPreview)
    .mockReset()
    .mockResolvedValue({ restore: false, retry: false, removedWorktree: '/feature' })
  vi.mocked(mergeOutcome).mockReset().mockResolvedValue('merged')
})

test.each([false, true])(
  'restoration refreshes the cached branch, including partial failure (%s)',
  async (partialFailure) => {
    const tree = (branch: string) => [
      { path: project.root, branch, head: 'head', current: true, main: true },
    ]
    vi.mocked(gitWorktrees)
      .mockResolvedValueOnce(tree('feature'))
      .mockResolvedValueOnce(tree('main'))
    refreshMainWorktree('p')
    await vi.waitFor(() => expect(useMainWorktree.getState().p?.branch).toBe('feature'))
    trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
    const failure = new Error('Original folder restored; branch deletion failed')
    if (partialFailure) vi.mocked(mergeCleanup).mockRejectedValueOnce(failure)
    else vi.mocked(mergeCleanup).mockResolvedValueOnce(undefined)
    const cleanup = deleteMergedWork(cleanupJobs()[0])
    if (partialFailure) await expect(cleanup).rejects.toThrow(failure.message)
    else await cleanup
    await vi.waitFor(() => expect(useMainWorktree.getState().p?.branch).toBe('main'))
  },
)

test('a merge into main stops its agent and starts the next task with a fresh lead', async () => {
  vi.mocked(completeTeamTask).mockClear()
  vi.mocked(terminalStop).mockClear()
  trackMergeCleanup(
    project,
    { ...request, source: project.root },
    'session',
    'merge',
    'keep',
    false,
  )
  useStore.setState({ sessions: { session: { running: true } } as never })
  expect(await completeTaskContext(cleanupJobs()[0])).toBe(true)
  expect(terminalStop).toHaveBeenCalledWith('session')
  expect(completeTeamTask).toHaveBeenCalledWith(
    'p',
    null,
    'task-done-merge',
    cleanupJobs()[0].startedMs,
  )
})

test('a cleanup decision stands while the lead completion waits for a retry', async () => {
  vi.mocked(completeTeamTask).mockRejectedValueOnce(new Error('pending'))
  trackMergeCleanup(
    project,
    { ...request, source: project.root },
    'session',
    'merge',
    'keep',
    false,
  )
  await finishCleanup(cleanupJobs()[0])
  expect(cleanupJobs()[0]).toMatchObject({ handled: true, contextPending: true })
  // A later merge must not forget the retry.
  trackMergeCleanup(project, { ...request, source: '/other' }, 'next', 'later', 'keep', false)
  expect(cleanupJobs().map((j) => j.id)).toEqual(['merge', 'later'])
  await finishCleanup(cleanupJobs()[0])
  expect(cleanupJobs()[0].contextPending).toBe(false)
})

test('a failed lead reset rejects so cleanup can retry it', async () => {
  vi.mocked(completeTeamTask).mockRejectedValueOnce(new Error('pending'))
  trackMergeCleanup(
    project,
    { ...request, source: project.root },
    'session',
    'merge',
    'keep',
    false,
  )
  await expect(completeTaskContext(cleanupJobs()[0])).rejects.toThrow('pending')
})

test('merges into other branches and unattached worktrees keep the lead', async () => {
  vi.mocked(completeTeamTask).mockClear()
  trackMergeCleanup(
    project,
    { ...request, source: project.root, destinationBranch: 'develop' },
    'session',
    'develop',
    'keep',
    false,
  )
  trackMergeCleanup(project, request, 'session', 'unattached', 'keep', false)
  for (const job of cleanupJobs()) expect(await completeTaskContext(job)).toBe(true)
  expect(completeTeamTask).not.toHaveBeenCalled()
})

test('deleting merged work starts its Chat over only once cleanup succeeds', async () => {
  vi.mocked(forgetTeamChat).mockClear()
  vi.mocked(gitWorktrees).mockResolvedValue([])
  trackMergeCleanup(
    project,
    { ...request, source: project.root },
    'session',
    'merge',
    'delete',
    false,
  )
  const [job] = cleanupJobs()
  vi.mocked(mergeCleanup).mockRejectedValueOnce(new Error('dirty'))
  await expect(deleteMergedWork(job)).rejects.toThrow('dirty')
  expect(forgetTeamChat).not.toHaveBeenCalled()
  vi.mocked(mergeCleanup).mockResolvedValueOnce(undefined)
  await deleteMergedWork(job)
  expect(forgetTeamChat).toHaveBeenCalledWith('p', null)
})

test('a cleanup that fails after removing the task still starts its Chat over', async () => {
  vi.mocked(forgetTeamChat).mockClear()
  vi.mocked(gitWorktrees).mockResolvedValue([])
  useStore.setState({ tasks: [{ id: 'task', worktree: request.source } as Task] })
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', false)
  vi.mocked(mergeCleanup).mockRejectedValueOnce(new Error('branch not deleted'))
  vi.mocked(refreshTasks).mockImplementationOnce(async () => useStore.setState({ tasks: [] }))
  await expect(deleteMergedWork(cleanupJobs()[0])).rejects.toThrow('branch not deleted')
  expect(forgetTeamChat).toHaveBeenCalledWith('p', 'task')
})

test('a cleanup that fails with the task intact keeps its Chat', async () => {
  vi.mocked(forgetTeamChat).mockClear()
  vi.mocked(gitWorktrees).mockResolvedValue([])
  useStore.setState({ tasks: [{ id: 'task', worktree: request.source } as Task] })
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', false)
  vi.mocked(mergeCleanup).mockRejectedValueOnce(new Error('dirty'))
  await expect(deleteMergedWork(cleanupJobs()[0])).rejects.toThrow('dirty')
  expect(forgetTeamChat).not.toHaveBeenCalled()
})

test('deleting an unattached worktree has no Chat to start over', async () => {
  vi.mocked(forgetTeamChat).mockClear()
  vi.mocked(gitWorktrees).mockResolvedValue([])
  vi.mocked(mergeCleanup).mockResolvedValueOnce(undefined)
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', false)
  await deleteMergedWork(cleanupJobs()[0])
  expect(forgetTeamChat).not.toHaveBeenCalled()
})

test('tracks cleanup independently of the visible view and remembers dismissal', () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
  expect(cleanupJobs()[0]).toMatchObject({ choice: 'ask', projectId: 'p' })
  handledCleanup('merge')
  expect(cleanupJobs()[0].handled).toBe(true)
})

test('waits for a finished session and confirmed Git integration', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', false)
  const job = cleanupJobs()[0]
  expect(await readyCleanup(job)).toBe(false)
  useStore.setState({ sessions: { session: { running: true } } as never })
  expect(await readyCleanup(job)).toBe(false)
  expect(mergeOutcome).not.toHaveBeenCalled()
  useStore.setState({ sessions: { session: { running: false } } as never })
  expect(await readyCleanup(job)).toBe(true)
  vi.mocked(mergeOutcome).mockResolvedValue('notMerged')
  expect(await readyCleanup(job)).toBe(false)
  vi.mocked(mergeOutcome).mockResolvedValue('inProgress')
  expect(await readyCleanup(job)).toBe(false)
})

test.each(['ask', 'delete'] as const)(
  'Auto %s cleanup survives normal completion and controller resumes',
  async (choice) => {
    trackMergeCleanup(project, request, 'session', 'merge', choice, true, 'owner')
    useStore.setState({
      sessions: { session: { running: false } } as never,
      auto: {
        runId: 'first',
        ownershipId: 'owner',
        sessionId: 'session',
        status: 'running',
      } as never,
    })
    expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
    useStore.setState({
      auto: { runId: 'resumed', ownershipId: 'owner', status: 'done' } as never,
    })
    expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
  },
)

test('a different Auto run cannot authorize cleanup through a reused merge session', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'delete', true, 'original')
  useStore.setState({
    sessions: { session: { running: false } } as never,
    auto: { runId: 'new', sessionId: 'session', status: 'done' } as never,
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
  expect(mergeOutcome).not.toHaveBeenCalled()
})

test('completed Auto cleanup follows its run in an inactive task workspace', async () => {
  trackMergeCleanup(project, request, 'session', 'merge', 'ask', true, 'run')
  useStore.setState({
    sessions: { session: { running: false } } as never,
    auto: null,
    taskWorkspaces: { task: { auto: { runId: 'run', status: 'done' } } } as never,
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
})

test('a newer merge replaces an older pending prompt for the same branch pair', () => {
  trackMergeCleanup(project, request, 'old-session', 'old', 'ask', false)
  trackMergeCleanup(project, request, 'new-session', 'new', 'ask', false)
  expect(cleanupJobs().map((j) => j.id)).toEqual(['new'])
})

test('partial restoration remains available after its merge session was retired', async () => {
  trackMergeCleanup(project, request, 'retired-session', 'merge', 'ask', false)
  expect(await readyCleanup(cleanupJobs()[0])).toBe(false)
  vi.mocked(mergeCleanupPreview).mockResolvedValue({
    restore: true,
    retry: true,
    removedWorktree: '/generated-main',
  })
  expect(await readyCleanup(cleanupJobs()[0])).toBe(true)
})

const chat = (): SimpleState => ({
  startedMs: 1,
  selectedAgent: 'lead',
  log: [
    {
      id: 'request',
      kind: 'prompt',
      stage: 'build',
      atMs: 10,
      text: 'Build the feature',
      mentions: [],
    },
    {
      id: 'reply',
      kind: 'reply',
      stage: 'build',
      sessionId: 'lead',
      generation: 1,
      sequence: 1,
      atMs: 20,
      text: 'Feature built',
    },
  ],
})
const rootMerge = { ...request, source: '/p', destination: '/generated-main' }
function prepareChatMerge(choice: 'ask' | 'keep' | 'delete' = 'ask') {
  useStore.setState({
    simple: chat(),
    sessions: {
      session: { running: false },
      lead: { running: true, generation: 1 },
      shell: { running: true, generation: 1 },
    } as Record<string, SessionState>,
    sessionRecords: [{ id: 'lead' }, { id: 'shell' }] as SessionRecord[],
  })
  trackMergeCleanup(project, rootMerge, 'session', 'merge', choice, false)
  return cleanupJobs()[0]
}

test.each(['ask', 'keep', 'delete'] as const)(
  'an unattached source worktree allows %s cleanup without clearing the project Chat',
  async (choice) => {
    prepareChatMerge(choice)
    trackMergeCleanup(project, request, 'session', 'external-merge', choice, false)
    const job = cleanupJobs().find((j) => j.id === 'external-merge')!
    const { simple, taskWorkspaces } = useStore.getState()
    expect(await completeMergeChat(job)).toBe(true)
    expect(useStore.getState().simple).toBe(simple)
    expect(useStore.getState().taskWorkspaces).toBe(taskWorkspaces)
    expect(cleanupJobs().find((j) => j.id === job.id)?.handled).not.toBe(true)
  },
)

test.each(['ask', 'keep', 'delete'] as const)(
  'a confirmed merge into main clears Chat with %s cleanup and preserves terminals',
  async (choice) => {
    const job = prepareChatMerge(choice)
    const { sessions, sessionRecords, rootTerminals, componentTerminals } = useStore.getState()
    const key = simpleKey('p', null)
    useSimpleUi.getState().patch(key, { draft: 'Next request', terminal: 'user' })
    const ui = useSimpleUi.getState().worktrees[key]
    expect(await completeMergeChat(job)).toBe(true)
    const state = useStore.getState()
    expect(state.simple?.log).toEqual([])
    expect(state.simple?.selectedAgent).toBe('lead')
    expect(state.sessions).toBe(sessions)
    expect(state.sessionRecords).toBe(sessionRecords)
    expect(state.rootTerminals).toBe(rootTerminals)
    expect(state.componentTerminals).toBe(componentTerminals)
    expect(useSimpleUi.getState().worktrees[key]).toBe(ui)
    expect(cleanupJobs()[0]).toMatchObject({ choice, chatCleared: true })
    expect(cleanupJobs()[0].handled).not.toBe(true)
    const restored = restoredSimple(JSON.parse(JSON.stringify(state.simple)))!
    expect(restored.log).toEqual([])
    expect(visibleReply(restored, 'lead', 1, { atMs: 20, sequence: 1 })).toBe(false)
  },
)

test.each(['notMerged', 'inProgress', 'dirty'] as const)(
  'Chat stays intact while Git reports %s',
  async (outcome) => {
    const job = prepareChatMerge()
    const simple = useStore.getState().simple
    vi.mocked(mergeOutcome).mockResolvedValue(outcome)
    expect(await completeMergeChat(job)).toBe(false)
    expect(useStore.getState().simple).toBe(simple)
    expect(cleanupJobs()[0].chatCleared).toBeUndefined()
  },
)

test('Chat waits for the merge agent and a failed Git read preserves history', async () => {
  const job = prepareChatMerge()
  const simple = useStore.getState().simple
  useStore.getState().setSession('session', { running: true })
  expect(await completeMergeChat(job)).toBe(false)
  expect(mergeOutcome).not.toHaveBeenCalled()
  useStore.getState().setSession('session', { running: false })
  vi.mocked(mergeOutcome).mockRejectedValue(new Error('Git unavailable'))
  await expect(completeMergeChat(job)).rejects.toThrow('Git unavailable')
  expect(useStore.getState().simple).toBe(simple)
})

test('a merge before Chat was opened still prevents old snapshot replies from appearing', async () => {
  const job = prepareChatMerge()
  useStore.setState({ simple: null })
  expect(await completeMergeChat(job)).toBe(true)
  const simple = useStore.getState().simple!
  expect(simple.log).toEqual([])
  expect(visibleReply(simple, 'lead', 1, { atMs: 20, sequence: 1 })).toBe(false)
})

test('a merge into another branch preserves Chat', async () => {
  prepareChatMerge()
  trackMergeCleanup(
    project,
    { ...rootMerge, destinationBranch: 'integration' },
    'session',
    'integration',
    'ask',
    false,
  )
  const simple = useStore.getState().simple
  expect(await completeMergeChat(cleanupJobs().find((j) => j.id === 'integration')!)).toBe(true)
  expect(useStore.getState().simple).toBe(simple)
})

test('repeated completion after restoring saved state preserves the next conversation', async () => {
  const job = prepareChatMerge()
  vi.mocked(mergeOutcome).mockResolvedValue('alreadyIntegrated')
  expect(await completeMergeChat(job)).toBe(true)
  // Restore the persisted completion marker, then start another conversation in the same folder.
  useStore.setState({
    workspaceSettings: JSON.parse(JSON.stringify(useStore.getState().workspaceSettings)),
  })
  const next = { ...useStore.getState().simple!, log: chat().log }
  useStore.setState({ simple: next })
  expect(await completeMergeChat(job)).toBe(true)
  expect(useStore.getState().simple).toBe(next)
})

test('completion clears only its source Chat after switching worktrees or projects', async () => {
  prepareChatMerge()
  useStore.setState({ tasks: [{ id: 'feature', worktree: '/feature' }] as never })
  useStore.getState().patchTask('p', 'feature', { simple: chat() })
  const rootChat = useStore.getState().simple
  trackMergeCleanup(project, request, 'session', 'feature-merge', 'ask', false)
  const job = cleanupJobs().find((j) => j.id === 'feature-merge')!
  useStore.getState().loadProject({ ...project, projectId: 'q', root: '/q' })
  useStore.setState({ simple: chat() })
  const otherChat = useStore.getState().simple
  expect(await completeMergeChat(job)).toBe(true)
  const saved = useStore.getState().captureProjects().p.state!
  expect(saved.taskWorkspaces.feature.simple?.log).toEqual([])
  expect(saved.simple).toBe(rootChat)
  expect(useStore.getState().simple).toBe(otherChat)
})

test('a superseded merge cannot clear Chat after its Git read completes', async () => {
  const job = prepareChatMerge()
  const simple = useStore.getState().simple
  let resolve!: (value: 'merged') => void
  vi.mocked(mergeOutcome).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const pending = completeMergeChat(job)
  trackMergeCleanup(project, rootMerge, 'new-session', 'new-merge', 'ask', false)
  resolve('merged')
  expect(await pending).toBe(false)
  expect(useStore.getState().simple).toBe(simple)
})
