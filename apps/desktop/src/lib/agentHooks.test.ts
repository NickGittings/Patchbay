import { beforeEach, expect, test, vi } from 'vitest'
import { create } from 'zustand'
import type { AgentIntegration } from '../types'

const store = create<{ project: null; workspaceSettings: Record<string, unknown> }>(() => ({
  project: null,
  workspaceSettings: {},
}))
vi.mock('../store', () => ({ useStore: store }))
const check =
  vi.fn<(provider: 'claude' | 'codex', source?: string) => Promise<Partial<AgentIntegration>>>()
const provider = vi.fn<(terminal: { command: string }) => Promise<'claude' | 'codex' | null>>()
vi.mock('./ipc', () => ({
  agentHooksCheck: (p: 'claude' | 'codex', source?: string) => check(p, source),
  agentProvider: (terminal: { command: string }) => provider(terminal),
}))
const {
  hookSource,
  hooksUsable,
  inferProvider,
  integrationsProvider,
  integrationsSetting,
  mergeRestoredHookSources,
  missingHooks,
  presetProvider,
  refreshAgentHooks,
  setHookSource,
  sessionReportedHooks,
  useAgentHooks,
  useInferredProviders,
} = await import('./agentHooks')
const { useRail } = await import('./rail')
const usable = { installed: true, disabled: false, reporterAvailable: true }
beforeEach(() => {
  check.mockReset()
  provider.mockReset()
  // Forgets the checks first, so resetting the sources asks for none.
  useAgentHooks.setState({}, true)
  store.setState({ workspaceSettings: {} })
  useInferredProviders.setState({}, true)
  useRail.setState({ settings: null })
})
test('hooks count as installed only when enabled with their reporter present', async () => {
  for (const [result, expected] of [
    [usable, true],
    [{ ...usable, installed: false }, false],
    [{ ...usable, disabled: true }, false],
    [{ ...usable, reporterAvailable: false }, false],
  ] as const) {
    expect(hooksUsable(result)).toBe(expected)
    check.mockResolvedValueOnce(result)
    await refreshAgentHooks('codex', true)
    expect(useAgentHooks.getState().codex).toBe(expected)
  }
})
test('an unreadable configuration is a failed check, which the next check retries', async () => {
  expect(useAgentHooks.getState().claude).toBeUndefined()
  check.mockRejectedValueOnce(new Error('Malformed Claude settings'))
  await refreshAgentHooks('claude')
  expect(useAgentHooks.getState().claude).toBe('failed')
  // Never fresh: a later mount asks again rather than keeping the failure.
  check.mockResolvedValueOnce(usable)
  await refreshAgentHooks('claude')
  expect(useAgentHooks.getState().claude).toBe(true)
  expect(check).toHaveBeenCalledTimes(2)
})
test('mounts share a check in flight and a fresh answer, unless forced', async () => {
  let answer: (value: Partial<AgentIntegration>) => void = () => {}
  check.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  const first = refreshAgentHooks('codex')
  const second = refreshAgentHooks('codex')
  expect(check).toHaveBeenCalledTimes(1)
  answer(usable)
  await Promise.all([first, second])
  await refreshAgentHooks('codex')
  expect(check).toHaveBeenCalledTimes(1)
  expect(useAgentHooks.getState().codex).toBe(true)
  check.mockResolvedValueOnce({ ...usable, installed: false })
  await refreshAgentHooks('codex', true)
  expect(check).toHaveBeenCalledTimes(2)
  expect(useAgentHooks.getState().codex).toBe(false)
  // Another source is another file: a remembered one is checked at once.
  check.mockResolvedValue(usable)
  setHookSource('codex', '/custom/hooks.json')
  await vi.waitFor(() => expect(useAgentHooks.getState().codex).toBe(true))
  expect(check).toHaveBeenLastCalledWith('codex', '/custom/hooks.json')
  expect(check).toHaveBeenCalledTimes(3)
})
test('a newer check wins, and closing the integrations dialog respects freshness', async () => {
  let answer: (value: Partial<AgentIntegration>) => void = () => {}
  check.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
  check.mockResolvedValueOnce({ ...usable, installed: false })
  const stale = refreshAgentHooks('claude')
  await refreshAgentHooks('claude', true)
  answer(usable)
  await stale
  expect(useAgentHooks.getState().claude).toBe(false)
  check.mockResolvedValue(usable)
  useRail.setState({ settings: integrationsSetting('codex') })
  useRail.setState({ settings: integrationsSetting() })
  expect(check).toHaveBeenCalledTimes(2)
  useRail.setState({ settings: null })
  expect(useAgentHooks.getState().claude).toBe(false)
  expect(check).toHaveBeenCalledTimes(2)
})
test('restoring keeps hook sources the user changed meanwhile', () => {
  const saved = { claude: '/saved/claude.json', codex: '/saved/codex.json' }
  // Nothing changed: the saved sources come back as they were.
  expect(mergeRestoredHookSources(saved, undefined, undefined)).toEqual(saved)
  // Codex was pinned and Claude returned to its default while restoring.
  expect(
    mergeRestoredHookSources(saved, { codex: '/new/codex.json' }, { claude: '/saved/claude.json' }),
  ).toEqual({ codex: '/new/codex.json' })
  expect(mergeRestoredHookSources(undefined, { claude: '/c' }, {})).toEqual({ claude: '/c' })
  expect(mergeRestoredHookSources(undefined, undefined, undefined)).toBeUndefined()
  expect(mergeRestoredHookSources({}, undefined, undefined)).toEqual({})
  expect(mergeRestoredHookSources('bad', {}, {})).toBeUndefined()
})
test('notices ask for hooks only of providers whose sessions do not report', () => {
  const hooks = { claude: false, codex: 'failed' } as const
  expect(missingHooks(['claude', 'codex'], hooks)).toEqual({ provider: 'claude', check: false })
  expect(missingHooks(['claude', 'codex'], hooks, new Set(['claude']))).toEqual({
    provider: 'codex',
    check: 'failed',
  })
  expect(missingHooks(['claude', 'codex'], hooks, new Set(['claude', 'codex']))).toBeUndefined()
  expect(missingHooks(['codex'], { codex: true })).toBeUndefined()
  expect(missingHooks(['codex'], {})).toBeUndefined()
})
test('checks read the hook source the dialog chose for each provider', async () => {
  check.mockResolvedValue(usable)
  await refreshAgentHooks('codex')
  expect(check).toHaveBeenLastCalledWith('codex', undefined)
  setHookSource('codex', '/custom/codex/hooks.json')
  expect(hookSource('codex')).toBe('/custom/codex/hooks.json')
  expect(hookSource('claude')).toBeUndefined()
  await refreshAgentHooks('codex')
  expect(check).toHaveBeenLastCalledWith('codex', '/custom/codex/hooks.json')
  const saved = store.getState().workspaceSettings
  setHookSource('codex', '/custom/codex/hooks.json')
  expect(store.getState().workspaceSettings).toBe(saved)
  setHookSource('codex', undefined)
  expect(hookSource('codex')).toBeUndefined()
  expect(store.getState().workspaceSettings.hookSources).toEqual({})
  store.setState({ workspaceSettings: { hookSources: { claude: 3 } } })
  expect(hookSource('claude')).toBeUndefined()
})
test('integration settings name the provider the dialog opens on', () => {
  expect(integrationsProvider(integrationsSetting())).toBeNull()
  expect(integrationsProvider(integrationsSetting('codex'))).toBe('codex')
  expect(integrationsProvider(integrationsSetting('claude'))).toBe('claude')
  expect(integrationsProvider('roles')).toBeUndefined()
  expect(integrationsProvider('integrations:other')).toBeUndefined()
  expect(integrationsProvider(null)).toBeUndefined()
})
test('presets without an adapter take the provider the backend infers', async () => {
  provider.mockResolvedValueOnce('claude').mockResolvedValueOnce(null)
  await Promise.all([inferProvider('claude --model opus'), inferProvider('claude --model opus')])
  await inferProvider('my-agent')
  expect(provider).toHaveBeenCalledTimes(2)
  const inferred = useInferredProviders.getState()
  expect(presetProvider({ command: 'claude --model opus' }, inferred)).toBe('claude')
  expect(presetProvider({ command: 'my-agent' }, inferred)).toBeNull()
  expect(presetProvider({ command: 'not checked' }, inferred)).toBeUndefined()
  expect(presetProvider({ command: 'wrapper', adapter: 'codex' }, inferred)).toBe('codex')
  expect(presetProvider(undefined, inferred)).toBeUndefined()
})

test('X → Y → X keeps the current source answer even when older requests finish last', async () => {
  const answers: ((value: Partial<AgentIntegration>) => void)[] = []
  check.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
  setHookSource('claude', '/X')
  const first = refreshAgentHooks('claude')
  setHookSource('claude', '/Y')
  const second = refreshAgentHooks('claude')
  setHookSource('claude', '/X')
  const third = refreshAgentHooks('claude')
  expect(check).toHaveBeenCalledTimes(3)
  answers[2](usable)
  await third
  answers[1]({ ...usable, installed: false })
  await second
  answers[0]({ ...usable, installed: false })
  await first
  expect(useAgentHooks.getState().claude).toBe(true)
})
test('a dialog save shares its answer and close/focus checks honor 30 second freshness', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
  try {
    const value = {
      ...usable,
      source: '/custom/hooks',
      defaultSource: '/default/hooks',
    } as AgentIntegration
    setHookSource('codex', value.source, value)
    await refreshAgentHooks('codex')
    useRail.setState({ settings: integrationsSetting('codex') })
    useRail.setState({ settings: null })
    expect(check).not.toHaveBeenCalled()
    now.mockReturnValue(130_001)
    check.mockResolvedValue(usable)
    await refreshAgentHooks('codex')
    expect(check).toHaveBeenCalledExactlyOnceWith('codex', value.source)
  } finally {
    now.mockRestore()
  }
})
test('native hook evidence survives Esc while legacy reports and stopped processes do not qualify', () => {
  const session = {
    running: true,
    status: { agent: { provider: 'codex', authoritative: false } },
  } as import('../types').SessionState
  expect(sessionReportedHooks(session)).toBe(true)
  expect(sessionReportedHooks({ ...session, running: false })).toBe(false)
  session.status!.agent!.provider = null
  expect(sessionReportedHooks(session)).toBe(false)
  expect(sessionReportedHooks(undefined)).toBe(false)
})
