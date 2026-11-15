import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prefs: vi.fn(),
  invoke: vi.fn(),
  external: vi.fn(),
  terminal: vi.fn(),
  message: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('./ipc', () => ({
  editorPreferences: mocks.prefs,
  editorOpen: mocks.external,
  terminalOpenReference: mocks.terminal,
}))
vi.mock('../store', () => ({
  useStore: {
    getState: () => ({
      project: { id: 'project' },
      activeTask: 'task',
      setMessage: mocks.message,
    }),
  },
}))
vi.mock('../types', () => ({ sessionMetadata: new Map() }))
vi.stubGlobal('window', new EventTarget())
vi.stubGlobal('navigator', { userAgent: 'Mac' })
const { openInEditor, openTerminalReference } = await import('./navigation')
const { FILE_EDITOR_EVENT } = await import('./fileEditor')
beforeEach(() => {
  vi.clearAllMocks()
  mocks.prefs.mockResolvedValue({})
  mocks.invoke.mockResolvedValue({ path: '/workspace/file.txt', isDir: false })
})
test('legacy preferences open files internally with captured worktree identity', async () => {
  const opened = vi.fn()
  window.addEventListener(FILE_EDITOR_EVENT, opened, { once: true })
  await openInEditor(
    { path: 'file.txt', line: 3 },
    { projectId: 'origin', task: null, worktree: '/tree' },
  )
  expect(mocks.external).not.toHaveBeenCalled()
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
    target: { path: '/workspace/file.txt', line: 3 },
    projectId: 'origin',
    task: null,
    worktree: '/tree',
  })
})
test('external mode and folders hand off to the external editor', async () => {
  mocks.prefs.mockResolvedValue({ fileOpenMode: 'external' })
  await openInEditor({ path: 'file.txt' })
  expect(mocks.external).toHaveBeenCalledWith({ path: 'file.txt' }, 'project', 'task', undefined)
  mocks.prefs.mockResolvedValue({ fileOpenMode: 'patchbay' })
  mocks.invoke.mockResolvedValue({ path: '/workspace', isDir: true })
  await openInEditor({ path: '.' })
  expect(mocks.external).toHaveBeenLastCalledWith({ path: '.' }, 'project', 'task', undefined)
})
test('terminal references retain backend-resolved originating identity and position', async () => {
  const request = {
    target: { path: '/original/file', line: 8, column: 2 },
    projectId: 'original',
    task: null,
  }
  mocks.invoke.mockResolvedValue(request)
  const opened = vi.fn()
  window.addEventListener(FILE_EDITOR_EVENT, opened, { once: true })
  await openTerminalReference('session', 'file:8:2', 4)
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_open_reference', {
    sessionId: 'session',
    generation: 4,
    reference: 'file:8:2',
    resolveOnly: true,
  })
  expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual(request)
  expect(mocks.terminal).not.toHaveBeenCalled()
})
test('unresolvable files report an error without opening an editor', async () => {
  mocks.invoke.mockRejectedValue(new Error('Outside project'))
  await openInEditor({ path: '../secret' })
  expect(mocks.message).toHaveBeenCalledWith('Error: Outside project')
  expect(mocks.external).not.toHaveBeenCalled()
})
