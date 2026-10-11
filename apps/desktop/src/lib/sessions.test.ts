import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { sessionId, type Project } from '../types'
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => ({ connected: true, instanceId: 'test' })),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('./ipc', () => ({
  sessionsList: vi.fn(async () => []),
  terminalStart: vi.fn(async () => ''),
  terminalStop: vi.fn(async () => {}),
  terminalSnapshot: vi.fn(async () => null),
  terminalCloseGuard: vi.fn(async () => 'lease'),
  releaseMapEdit: vi.fn(async () => {}),
  onTerminalEvent: vi.fn(async () => () => {}),
  planStart: vi.fn(),
  extensionTerminalRun: vi.fn(),
}))
vi.mock('../extensions/host', () => ({ executeExtensionCommand: vi.fn() }))
vi.mock('./windows', () => ({ showsSession: vi.fn() }))
vi.mock('./git', () => ({ requestGitRefresh: vi.fn() }))
vi.mock('./terminals', () => ({
  disposeAll: vi.fn(),
  markOutputGeneration: vi.fn(),
  replayOutput: vi.fn(),
  restoreOutput: vi.fn(),
  writeNote: vi.fn(),
  writeOutput: vi.fn(),
}))
const ipc = await import('./ipc')
const { closeTerminal, startTerminal, restartTerminal, resetSessions } = await import('./sessions')
const project: Project = {
  schemaVersion: 4,
  projectId: 'p',
  root: '/p',
  name: 'P',
  links: [],
  components: [
    {
      id: 'web',
      name: 'Web',
      path: '.',
      kind: 'app',
      notes: '',
      position: { x: 0, y: 0 },
      terminals: [{ id: 'dev', name: 'Dev', command: 'cat', kind: 'task' }],
    },
  ],
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ipc.terminalStart).mockResolvedValue('')
  vi.mocked(ipc.terminalStop).mockResolvedValue(undefined)
  vi.mocked(ipc.terminalSnapshot).mockResolvedValue(null)
  vi.mocked(ipc.sessionsList).mockResolvedValue([])
  resetSessions(0)
  useStore.setState(useStore.getInitialState())
  useStore.getState().loadProject(project)
  useStore.setState({ serviceConnected: true })
})
const hasTerminal = () => useStore.getState().nodes[0].data.terminals.length === 1

test('close stops every worktree copy, including records unknown to this window', async () => {
  const own = sessionId('web', 'dev', null, 'p')
  const task = sessionId('web', 'dev', 'task', 'p')
  const foreign = sessionId('web', 'dev', null, 'other')
  vi.mocked(ipc.sessionsList).mockResolvedValue([
    { id: 'unhydrated', metadata: { projectId: 'p', componentId: 'web', terminalId: 'dev' } },
  ] as Awaited<ReturnType<typeof ipc.sessionsList>>)
  useStore.setState({ activeSession: task, revealed: { componentId: 'web', sid: task } })
  expect(await closeTerminal('web', 'dev')).toBe(true)
  const stopped = vi.mocked(ipc.terminalStop).mock.calls.map(([sid]) => sid)
  expect(stopped).toEqual(expect.arrayContaining([own, task, 'unhydrated']))
  expect(stopped).not.toContain(foreign)
  expect(hasTerminal()).toBe(false)
  expect(useStore.getState().activeSession).toBeNull()
  expect(useStore.getState().revealed).toBeNull()
  expect(ipc.releaseMapEdit).toHaveBeenCalledWith('p', 'lease')
})
test('close waits for a spawn without a started event, then stops it', async () => {
  const spawn = deferred()
  vi.mocked(ipc.terminalStart).mockImplementationOnce(async () => {
    await spawn.promise
    return ''
  })
  const start = startTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStart).toHaveBeenCalled())
  const close = closeTerminal('web', 'dev')
  await startTerminal('web', 'dev', 'new-task')
  expect(ipc.terminalStart).toHaveBeenCalledTimes(1)
  expect(ipc.terminalStop).not.toHaveBeenCalled()
  expect(hasTerminal()).toBe(true)
  spawn.resolve()
  await start
  expect(await close).toBe(true)
  expect(ipc.terminalStop).toHaveBeenCalledWith(sessionId('web', 'dev', null, 'p'))
})
test('close during the restart gap prevents its replacement spawn', async () => {
  const stop = deferred()
  vi.mocked(ipc.terminalStop).mockImplementationOnce(() => stop.promise)
  const restart = restartTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStop).toHaveBeenCalled())
  const close = closeTerminal('web', 'dev')
  stop.resolve()
  await restart
  expect(await close).toBe(true)
  expect(ipc.terminalStart).not.toHaveBeenCalled()
})
test('failed stop keeps the saved terminal and releases its removal guard', async () => {
  sessionId('web', 'dev', null, 'p')
  vi.mocked(ipc.terminalStop).mockRejectedValueOnce(new Error('Disconnected'))
  expect(await closeTerminal('web', 'dev')).toBe(false)
  expect(hasTerminal()).toBe(true)
  expect(ipc.releaseMapEdit).toHaveBeenCalledWith('p', 'lease')
})
test('tab switch while closing edits only the originating project', async () => {
  const stop = deferred()
  sessionId('web', 'dev', null, 'p')
  vi.mocked(ipc.terminalStop).mockImplementationOnce(() => stop.promise)
  const close = closeTerminal('web', 'dev')
  await vi.waitFor(() => expect(ipc.terminalStop).toHaveBeenCalled())
  useStore.getState().loadProject({ ...project, projectId: 'other', root: '/other' })
  stop.resolve()
  expect(await close).toBe(true)
  expect(hasTerminal()).toBe(true)
  expect(useStore.getState().captureProjects().p.state?.nodes[0].data.terminals).toEqual([])
})

test('reconciliation recovers merge records without registering generic runtime terminals', async () => {
  useStore.setState({ serviceInstance: 'test' })
  const record = {
    id: 'merge',
    metadata: {
      projectId: 'p',
      componentId: '@merge',
      terminalId: 'merge',
      name: 'Merge',
      kind: 'agent',
    },
    spec: { cwd: '/p', command: 'codex' },
    snapshot: null,
    history: [],
  } as unknown as import('../types').SessionRecord
  useStore.getState().addRuntimeTerminal('merge', {
    projectId: 'p',
    componentId: '@merge',
    terminal: { id: 'merge', name: 'Merge', kind: 'agent', command: 'codex' },
  })
  vi.mocked(ipc.sessionsList).mockResolvedValue([record])
  const { reconcileSessions } = await import('./sessions')
  await reconcileSessions()
  expect(useStore.getState().sessionRecords).toEqual([record])
  expect(useStore.getState().runtimeTerminals.merge).toBeUndefined()
  await reconcileSessions()
  expect(useStore.getState().runtimeTerminals.merge).toBeUndefined()
})
