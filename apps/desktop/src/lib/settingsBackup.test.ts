import { beforeEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'

const messages: { text: string; kind?: string }[] = []
const store = create<Record<string, unknown>>(() => ({}))
vi.mock('../store', () => ({ useStore: store }))
const invoke = vi.fn<(command: string, args?: unknown) => Promise<unknown>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }))
const flush = vi.fn(async (_strict?: boolean) => {})
let blocked: string | null = null
vi.stubGlobal('window', new EventTarget())
vi.mock('./workspace', () => ({
  workspaceSaveBlocked: () => blocked,
  flushWorkspace: (strict?: boolean) => flush(strict),
  workspaceDocument: () => ({ settings: { agentRoles: { review: ['codex'] } } }),
}))
vi.mock('./ipc', () => ({ listDevices: async () => [{ id: 'profile-1' }] }))
const {
  PORTABLE_SETTINGS,
  SETTINGS_IMPORTED_EVENT,
  exportSettings,
  importSettings,
  importedSettingsState,
  missingPresets,
} = await import('./settingsBackup')

beforeEach(() => {
  messages.length = 0
  blocked = null
  invoke.mockReset()
  flush.mockClear()
  store.setState(
    {
      agentRoles: {},
      workspaceSettings: {
        hookSources: { claude: 'local' },
        mergeCleanupJobs: [{ id: 'pending' }],
        chatAgent: 'old',
      },
      devices: [],
      setDevices: (devices: unknown) => store.setState({ devices }),
      setMessage: (text: string, _transient?: boolean, _action?: unknown, kind?: string) =>
        messages.push({ text, kind }),
    },
    true,
  )
})

test('portable settings match the Rust list', () => {
  expect(PORTABLE_SETTINGS).toEqual([
    'agentRoles',
    'notifications',
    'usage',
    'chatAgent',
    'autoKeepAwake',
    'mergeCleanup',
    'reviewCouncil',
  ])
})

test('imported preferences replace choices and leave this machine’s state alone', () => {
  const next = importedSettingsState(
    {
      agentRoles: { review: ['codex'], bogus: 3 },
      notifications: 'not an object',
      usage: { warnPercent: 70 },
      chatAgent: 'imported',
      reviewCouncil: { enabled: true, members: ['a', 'b'] },
      hookSources: { claude: 'elsewhere' },
      mergeCleanupJobs: [{ id: 'stale' }],
      futureSetting: { kept: true },
    },
    {
      workspaceSettings: {
        hookSources: { claude: 'local' },
        mergeCleanupJobs: [{ id: 'pending' }],
        autoKeepAwake: true,
      },
    },
  )
  expect(next.agentRoles).toEqual({ review: ['codex'] })
  expect(next.usageSettings?.warnPercent).toBe(70)
  expect(next.notifications).toBeTypeOf('object')
  expect(next.workspaceSettings).toEqual({
    chatAgent: 'imported',
    reviewCouncil: { enabled: true, members: ['a', 'b'] },
    hookSources: { claude: 'local' },
    mergeCleanupJobs: [{ id: 'pending' }],
    autoKeepAwake: true,
  })
})

test('settings missing from the file keep their current values', () => {
  const next = importedSettingsState({}, { workspaceSettings: { chatAgent: 'mine' } })
  expect(next).toEqual({ workspaceSettings: { chatAgent: 'mine' } })
})

test('presets the settings name but this machine lacks are reported once', () => {
  expect(
    missingPresets(
      {
        agentRoles: { review: ['codex', 'gone'], plan: ['gone'] },
        workspaceSettings: { chatAgent: 'chat-gone', reviewCouncil: { members: ['codex', 'x'] } },
      },
      [{ id: 'codex' }],
    ),
  ).toEqual(['gone', 'chat-gone', 'x'])
})

test('export and import wait while the workspace cannot be saved', async () => {
  blocked = 'Wait until Patchbay finishes restoring the workspace'
  await exportSettings()
  await importSettings()
  expect(invoke).not.toHaveBeenCalled()
  expect(messages.map((m) => m.text)).toEqual([blocked, blocked])
})

test('export sends the workspace settings block and reports the path', async () => {
  invoke.mockResolvedValueOnce('/tmp/out.json')
  await exportSettings()
  expect(invoke).toHaveBeenCalledWith('settings_export', {
    settings: { agentRoles: { review: ['codex'] } },
  })
  expect(messages[0].text).toContain('/tmp/out.json')
})

test('a cancelled import changes nothing', async () => {
  invoke.mockResolvedValueOnce(null)
  await importSettings()
  expect(flush).not.toHaveBeenCalled()
  expect(store.getState().workspaceSettings).toMatchObject({ chatAgent: 'old' })
  expect(messages).toEqual([])
})

test('import applies, saves, refreshes devices and names profiles that need keys', async () => {
  invoke.mockResolvedValueOnce({
    settings: { chatAgent: 'imported' },
    profilesNeedingKeys: ['Router'],
    profilesMissingPrograms: ['Far'],
  })
  const refreshed = vi.fn()
  window.addEventListener(SETTINGS_IMPORTED_EVENT, refreshed)
  await importSettings()
  window.removeEventListener(SETTINGS_IMPORTED_EVENT, refreshed)
  expect(store.getState().workspaceSettings).toMatchObject({
    chatAgent: 'imported',
    mergeCleanupJobs: [{ id: 'pending' }],
  })
  expect(flush).toHaveBeenCalledWith(true)
  expect(refreshed).toHaveBeenCalledOnce()
  expect(store.getState().devices).toEqual([{ id: 'profile-1' }])
  expect(messages[0].text).toContain('Router')
  expect(messages[0].text).toContain('Far')
  expect(messages[0].text).toContain('imported')
})

test('import errors are shown', async () => {
  invoke.mockRejectedValueOnce('Not a Patchbay settings file')
  await importSettings()
  expect(messages[0]).toEqual({ text: 'Not a Patchbay settings file', kind: 'error' })
})
