import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { closeProjectTab } from './project'
import { projectClose } from './ipc'
import { flushMapSaves } from './mapSave'
import { flushWorkspace } from './workspace'
import { closeComponentWindows } from './windows'

vi.mock('./ipc', () => ({ projectClose: vi.fn() }))
vi.mock('./mapSave', () => ({ flushMapSaves: vi.fn() }))
vi.mock('./workspace', () => ({ flushWorkspace: vi.fn() }))
vi.mock('./windows', () => ({ closeComponentWindows: vi.fn() }))
vi.mock('./maintenance', () => ({ reviewRescan: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState(), true)
  useStore.getState().loadProject({
    projectId: 'one',
    schemaVersion: 4,
    name: 'One',
    root: '/tmp/one',
    components: [],
    links: [],
    groups: [],
  })
  vi.mocked(flushMapSaves).mockResolvedValue(true)
  vi.mocked(flushWorkspace).mockResolvedValue(undefined)
})

test('saves maps, closes pop-outs and the backend, then removes the tab and persists it', async () => {
  vi.mocked(closeComponentWindows).mockImplementation(async () => {
    expect(flushMapSaves).toHaveBeenCalledWith('one')
    expect(useStore.getState().projects.one).toBeDefined()
  })
  vi.mocked(projectClose).mockImplementation(async () => {
    expect(closeComponentWindows).toHaveBeenCalledWith('one')
    expect(useStore.getState().projects.one).toBeDefined()
  })
  vi.mocked(flushWorkspace).mockImplementation(async () => {
    expect(projectClose).toHaveBeenCalledWith('one')
    expect(useStore.getState().projectOrder).toEqual([])
  })
  await closeProjectTab('one')
  expect(flushWorkspace).toHaveBeenCalledOnce()
})

test('preserves the tab and its recovery draft when the map cannot save', async () => {
  vi.mocked(flushMapSaves).mockResolvedValue(false)
  await closeProjectTab('one')
  expect(useStore.getState().projects.one).toBeDefined()
  expect(closeComponentWindows).not.toHaveBeenCalled()
  expect(projectClose).not.toHaveBeenCalled()
  expect(flushWorkspace).toHaveBeenCalledOnce()
  expect(useStore.getState().message).toContain('Map could not be saved')
})

test('handles a map-save rejection and persists the retained tab', async () => {
  vi.mocked(flushMapSaves).mockRejectedValue(new Error('map I/O failed'))
  await expect(closeProjectTab('one')).resolves.toBeUndefined()
  expect(useStore.getState().projects.one).toBeDefined()
  expect(flushWorkspace).toHaveBeenCalledOnce()
  expect(useStore.getState().message).toContain('map I/O failed')
})

test('keeps the tab available to retry when closing a pop-out fails', async () => {
  vi.mocked(closeComponentWindows).mockRejectedValue(new Error('window close failed'))
  await expect(closeProjectTab('one')).resolves.toBeUndefined()
  expect(useStore.getState().projects.one).toBeDefined()
  expect(projectClose).not.toHaveBeenCalled()
  expect(flushWorkspace).toHaveBeenCalledOnce()
  expect(useStore.getState().message).toContain('window close failed')
})

test('keeps the tab available to retry when backend cleanup fails', async () => {
  vi.mocked(projectClose).mockRejectedValueOnce(new Error('backend disconnected'))
  await expect(closeProjectTab('one')).resolves.toBeUndefined()
  expect(useStore.getState().projects.one).toBeDefined()
  expect(useStore.getState().projectOrder).toEqual(['one'])
  expect(flushWorkspace).toHaveBeenCalledOnce()
  expect(useStore.getState().message).toContain('Project close failed: Error: backend disconnected')
  // A retry releases the backend and removes the tab.
  vi.mocked(projectClose).mockResolvedValue(undefined)
  await closeProjectTab('one')
  expect(projectClose).toHaveBeenCalledTimes(2)
  expect(useStore.getState().projects.one).toBeUndefined()
})

test('reports a workspace-save rejection without an unhandled promise', async () => {
  vi.mocked(flushWorkspace).mockRejectedValue(new Error('workspace I/O failed'))
  await expect(closeProjectTab('one')).resolves.toBeUndefined()
  expect(useStore.getState().message).toContain('workspace I/O failed')
})
