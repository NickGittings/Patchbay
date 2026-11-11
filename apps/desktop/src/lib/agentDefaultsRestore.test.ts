import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceDocument } from '../types'

vi.mock('./ipc', () => ({
  workspaceLoad: vi.fn(),
  workspaceSave: vi.fn(),
  quitPatchbay: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn(async () => () => {}) }),
}))
vi.mock('./mapSave', () => ({ initializeMapAutosave: vi.fn(), flushMapSaves: vi.fn() }))
vi.mock('./sessions', () => ({ reconcileSessions: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

test.each([false, true])(
  'restore migrates global roles and preserves edits during load: %s',
  async (edit) => {
    vi.resetModules()
    vi.useFakeTimers()
    const { useStore } = await import('../store')
    const ipc = await import('./ipc')
    const { initializeWorkspace } = await import('./workspace')
    const document: WorkspaceDocument = {
      version: 1,
      activeProject: 'safari',
      windows: {},
      projects: ['krilo', 'safari'].map((id) => ({
        id,
        name: id,
        root: `/${id}`,
        savedFingerprint: 'fingerprint',
        draft: null,
        layout: id === 'krilo' ? { agentRoles: { review: ['codex'] }, implementSubagents: 3 } : {},
      })),
    }
    let finish!: (value: Awaited<ReturnType<typeof ipc.workspaceLoad>>) => void
    vi.mocked(ipc.workspaceLoad).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const loading = initializeWorkspace()
    await vi.waitFor(() => expect(ipc.workspaceLoad).toHaveBeenCalled())
    if (edit) {
      useStore.getState().setAgentRoles({ review: ['claude'] })
      useStore.getState().setImplementSubagents(5)
    }
    finish({
      document,
      errors: {},
      opened: document.projects.map((p) => ({
        id: p.id,
        fingerprint: p.savedFingerprint,
        detected: false,
        locked: [],
        project: { schemaVersion: 4, name: p.name, root: p.root, components: [], links: [] },
      })),
    })
    await loading
    const roles = { review: [edit ? 'claude' : 'codex'] }
    expect(useStore.getState().agentRoles).toEqual(roles)
    expect(useStore.getState().implementSubagents).toBe(edit ? 5 : 3)
    useStore.getState().activateProject('krilo')
    expect(useStore.getState().agentRoles).toEqual(roles)
    await vi.advanceTimersByTimeAsync(500)
    const saved = vi.mocked(ipc.workspaceSave).mock.calls.at(-1)![0]
    expect(saved.settings).toMatchObject({ agentRoles: roles, implementSubagents: edit ? 5 : 3 })
    expect(saved.projects.every((p) => !('agentRoles' in p.layout))).toBe(true)
  },
)
