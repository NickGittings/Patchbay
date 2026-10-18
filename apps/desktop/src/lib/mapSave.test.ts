import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { Project } from '../types'
import { reloadProject, saveProject } from './ipc'
import {
  disposeMapAutosave,
  flushMapSaves,
  initializeMapAutosave,
  onMapCreated,
  reloadSavedMap,
  saveMap,
  saveMapNow,
} from './mapSave'

vi.mock('./ipc', () => ({ saveProject: vi.fn(), reloadProject: vi.fn() }))
const save = vi.mocked(saveProject)
const reload = vi.mocked(reloadProject)
const state = () => useStore.getState()
function open(id = 'one', fingerprint = 'saved-0') {
  state().loadProject({
    projectId: id,
    schemaVersion: 4,
    name: id,
    root: `/tmp/${id}`,
    components: [
      {
        id: 'web',
        name: 'Web',
        kind: 'frontend',
        path: '.',
        notes: '',
        terminals: [],
        position: { x: 0, y: 0 },
      },
    ],
    links: [],
    groups: [],
  })
  useStore.setState((s) => ({
    projects: { ...s.projects, [id]: { ...s.projects[id], fingerprint } },
  }))
}
function edit(notes = 'edited') {
  state().updateComponent('web', { notes })
}
function entry(id = 'one') {
  return state().captureProjects()[id]
}

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ restoring: false })
  let revision = 0
  save.mockReset().mockImplementation(async () => ({
    status: 'saved',
    path: '/tmp/patchbay.json',
    fingerprint: `saved-${++revision}`,
  }))
  reload.mockReset()
})
afterEach(() => {
  disposeMapAutosave()
  vi.useRealTimers()
})

describe('map autosave', () => {
  test('requires explicit creation, then automatically saves later edits', async () => {
    open('one', 'absent')
    useStore.setState({ dirty: true })
    initializeMapAutosave()
    edit()
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
    expect(await saveMap('one')).toBe(true)
    expect(save.mock.calls[0][1]).toBe('absent')
    expect(entry().state?.dirty).toBe(false)
    edit('later')
    await vi.advanceTimersByTimeAsync(750)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][1]).toBe('saved-1')
  })

  test('announces only the first creation, not later saves or conflicts', async () => {
    const created = vi.fn()
    const stop = onMapCreated(created)
    open('one', 'absent')
    useStore.setState({ dirty: true })
    initializeMapAutosave()
    save.mockResolvedValueOnce({ status: 'conflict', fingerprint: 'external' })
    expect(await saveMap('one')).toBe(false)
    expect(created).not.toHaveBeenCalled()
    expect(await saveMap('one', true)).toBe(true)
    expect(created).toHaveBeenCalledExactlyOnceWith('one')
    edit('later')
    await vi.advanceTimersByTimeAsync(750)
    expect(save).toHaveBeenCalledTimes(3)
    expect(created).toHaveBeenCalledTimes(1)
    stop()
  })

  test('debounces map changes but ignores selection, sessions and layout', async () => {
    open()
    initializeMapAutosave()
    state().select('web')
    state().setView('plan')
    state().setViewport({ x: 10, y: 20, zoom: 2 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    edit('first')
    await vi.advanceTimersByTimeAsync(500)
    edit('second')
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
    state().select(null)
    await vi.advanceTimersByTimeAsync(250)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0].components[0].notes).toBe('second')
  })

  test('waits for a completed canvas drag even when other changes were pending', async () => {
    open()
    initializeMapAutosave()
    edit()
    state().onNodesChange([
      { id: 'web', type: 'position', position: { x: 10, y: 20 }, dragging: true },
    ])
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).not.toHaveBeenCalled()
    state().onNodesChange([
      { id: 'web', type: 'position', position: { x: 30, y: 40 }, dragging: false },
    ])
    await vi.advanceTimersByTimeAsync(750)
    expect(save.mock.calls[0][0].components[0].position).toEqual({ x: 30, y: 40 })
  })

  test('saves an inactive tab without cleaning the active tab', async () => {
    open()
    initializeMapAutosave()
    edit('first project')
    open('two', 'absent')
    edit('second project')
    await vi.advanceTimersByTimeAsync(750)
    expect(save.mock.calls[0][0].projectId).toBe('one')
    expect(entry('one').state?.dirty).toBe(false)
    expect(state().dirty).toBe(true)
    expect(entry('two').fingerprint).toBe('absent')
  })

  test('serializes writes and preserves edits made during a write', async () => {
    open()
    initializeMapAutosave()
    let finish!: (value: Awaited<ReturnType<typeof saveProject>>) => void
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    edit('first')
    await vi.advanceTimersByTimeAsync(750)
    expect(entry().mapSave?.status).toBe('saving')
    edit('second')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    finish({ status: 'saved', path: '/tmp/patchbay.json', fingerprint: 'saved-first' })
    await vi.advanceTimersByTimeAsync(0)
    expect(state().dirty).toBe(true)
    await vi.advanceTimersByTimeAsync(750)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].components[0].notes).toBe('second')
    expect(save.mock.calls[1][1]).toBe('saved-first')
    expect(state().dirty).toBe(false)
  })

  test('manual Save now flushes edits made during an earlier write', async () => {
    open()
    initializeMapAutosave()
    let finish!: (value: Awaited<ReturnType<typeof saveProject>>) => void
    save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    edit('first')
    await vi.advanceTimersByTimeAsync(750)
    edit('latest')
    const manual = saveMapNow('one')
    finish({ status: 'saved', path: '/tmp/patchbay.json', fingerprint: 'first' })
    expect(await manual).toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0].components[0].notes).toBe('latest')
    expect(state().dirty).toBe(false)
  })

  test('choosing the saved map clears a restored conflict and interim edits', async () => {
    open()
    initializeMapAutosave()
    const saved = state().toProject()
    useStore.setState((s) => ({
      projects: { ...s.projects, one: { ...s.projects.one, conflict: saved } },
    }))
    edit('interim local edit')
    reload.mockResolvedValue({
      id: 'one',
      fingerprint: 'saved-0',
      project: saved,
      detected: false,
      locked: [],
    })
    await reloadSavedMap('one')
    expect(state().nodes[0].data.notes).toBe('')
    expect(entry().conflict).toBeUndefined()
    expect(state().dirty).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
  })

  test('retains failed edits, stops automatic retries, and retries explicitly', async () => {
    open()
    initializeMapAutosave()
    save.mockRejectedValueOnce(new Error('disk full'))
    edit()
    await vi.advanceTimersByTimeAsync(750)
    expect(entry().mapSave).toEqual({ status: 'error', error: 'Error: disk full' })
    expect(state().dirty).toBe(true)
    edit('newer')
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(await saveMap('one')).toBe(true)
    expect(state().dirty).toBe(false)
  })

  test('does not overwrite external edits without an explicit replacement', async () => {
    open()
    initializeMapAutosave()
    save.mockResolvedValueOnce({ status: 'conflict', fingerprint: 'external' })
    edit()
    await vi.advanceTimersByTimeAsync(750)
    expect(entry().mapSave?.status).toBe('conflict')
    expect(await saveMap('one')).toBe(false)
    expect(await flushMapSaves('one')).toBe(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(await saveMap('one', true)).toBe(true)
    expect(save.mock.calls[1][1]).toBeNull()
  })

  test('reloads the saved map and discards the pending local edit', async () => {
    open()
    initializeMapAutosave()
    save.mockResolvedValueOnce({ status: 'conflict', fingerprint: 'external' })
    edit()
    await vi.advanceTimersByTimeAsync(750)
    const project: Project = { ...state().toProject(), components: [] }
    reload.mockResolvedValue({
      id: 'one',
      fingerprint: 'external',
      project,
      detected: false,
      locked: [],
    })
    await reloadSavedMap('one')
    expect(state().nodes).toEqual([])
    expect(state().dirty).toBe(false)
    expect(entry().fingerprint).toBe('external')
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('pauses during restoration and unresolved draft conflicts', async () => {
    open()
    useStore.setState({ restoring: true })
    initializeMapAutosave()
    edit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    useStore.setState((s) => ({
      restoring: false,
      projects: { ...s.projects, one: { ...s.projects.one, conflict: s.toProject() } },
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).not.toHaveBeenCalled()
    useStore.setState((s) => ({
      projects: { ...s.projects, one: { ...s.projects.one, conflict: undefined } },
    }))
    await vi.advanceTimersByTimeAsync(750)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('matching recovered drafts autosave for existing files only', async () => {
    open()
    edit('recovered')
    initializeMapAutosave()
    await vi.advanceTimersByTimeAsync(750)
    expect(save).toHaveBeenCalledTimes(1)
    open('two', 'absent')
    edit('recovered absent')
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  test('flushes pending projects immediately without creating absent configurations', async () => {
    open()
    initializeMapAutosave()
    edit()
    open('two', 'saved-two')
    edit()
    open('three', 'absent')
    edit()
    expect(await flushMapSaves()).toBe(true)
    expect(save.mock.calls.map(([project]) => project.projectId)).toEqual(['one', 'two'])
    expect(state().dirty).toBe(true)
  })

  test('reports flush failures so closing a project can retain its draft', async () => {
    open()
    initializeMapAutosave()
    edit()
    save.mockRejectedValue(new Error('permission denied'))
    expect(await flushMapSaves('one')).toBe(false)
    expect(entry().state?.dirty).toBe(true)
    expect(entry().mapSave?.status).toBe('error')
  })

  test('does not lose a failed first creation when closing the project', async () => {
    open('one', 'absent')
    initializeMapAutosave()
    edit()
    save.mockRejectedValue(new Error('permission denied'))
    expect(await saveMap('one')).toBe(false)
    expect(await flushMapSaves('one')).toBe(false)
    expect(entry().state?.dirty).toBe(true)
  })
})
