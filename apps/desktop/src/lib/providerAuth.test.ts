import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import { useSimpleUi, simpleKey } from './simpleUi'
import { useAgentHooks } from './agentHooks'
import type { AuthRequest, AuthStatus } from './providerAuth'

vi.mock('./ipc', () => ({
  agentProvider: vi.fn(),
  providerAuthCheck: vi.fn(),
  sessionsList: vi.fn(async () => []),
}))
const ipc = await import('./ipc')
const auth = await import('./providerAuth')
const request: AuthRequest = { provider: 'codex', terminal: { command: 'codex' } }
const result = (state: AuthStatus['state']): AuthStatus => ({
  provider: 'codex',
  state,
  message: state,
})
beforeEach(() => {
  vi.resetAllMocks()
  auth.invalidateProviderAuth()
  auth.useProviderSetup.setState({ pending: null })
  useStore.setState(useStore.getInitialState())
  vi.mocked(ipc.agentProvider).mockResolvedValue('codex')
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue(result('signedOut'))
})
test('prompts on the detected provider without changing drafts, selections or hooks', async () => {
  const key = simpleKey('p', null)
  useSimpleUi.getState().patch(key, { draft: 'Keep my draft' })
  useStore.setState({ selectedId: 'web', highlighted: ['web'] })
  useAgentHooks.setState({ claude: true, codex: false })
  const before = useSimpleUi.getState()
  await expect(auth.requireProviderAuth({ terminal: { command: 'codex' } })).rejects.toThrow(
    auth.ProviderSetupRequired,
  )
  expect(auth.useProviderSetup.getState().pending?.request.provider).toBe('codex')
  expect(useSimpleUi.getState()).toBe(before)
  expect(useStore.getState().highlighted).toEqual(['web'])
  expect(useStore.getState().selectedId).toBe('web')
  expect(useAgentHooks.getState()).toMatchObject({ claude: true, codex: false })
})
test('login invalidation and a fresh check never relaunch the original action', async () => {
  const launch = vi.fn()
  const action = async () => {
    await auth.requireProviderAuth({ terminal: { command: 'codex' } })
    launch()
  }
  await expect(action()).rejects.toThrow(auth.ProviderSetupRequired)
  auth.invalidateProviderAuth()
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue(result('signedIn'))
  await auth.checkProviderAuth(request, true)
  auth.useProviderSetup.setState({ pending: null })
  expect(launch).not.toHaveBeenCalled()
  await action()
  expect(launch).toHaveBeenCalledTimes(1)
})
test('concurrent checks share a request and cache by launch context', async () => {
  await Promise.all([auth.checkProviderAuth(request), auth.checkProviderAuth(request)])
  await auth.checkProviderAuth(request)
  expect(ipc.providerAuthCheck).toHaveBeenCalledTimes(1)
  await auth.checkProviderAuth({ ...request, task: 'another-worktree' })
  expect(ipc.providerAuthCheck).toHaveBeenCalledTimes(2)
})
test('stale responses cannot replace a fresh check or permit a launch after invalidation', async () => {
  let resolve!: (r: AuthStatus) => void
  vi.mocked(ipc.providerAuthCheck).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const old = auth.checkProviderAuth(request)
  await auth.checkProviderAuth(request, true)
  resolve(result('signedIn'))
  await old
  expect((await auth.checkProviderAuth(request)).state).toBe('signedOut')
  auth.invalidateProviderAuth()
  vi.mocked(ipc.providerAuthCheck).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const blocked = auth.requireProviderAuth({ terminal: { command: 'codex' } })
  await vi.waitFor(() => expect(ipc.providerAuthCheck).toHaveBeenCalledTimes(3))
  auth.invalidateProviderAuth()
  resolve(result('signedIn'))
  await expect(blocked).rejects.toThrow(auth.ProviderSetupRequired)
})
test('Continue anyway applies to one context and still requires the next click', async () => {
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue(result('unknown'))
  await expect(auth.requireProviderAuth({ terminal: { command: 'codex' } })).rejects.toThrow()
  const pending = auth.useProviderSetup.getState().pending!
  auth.continueProviderSetup(pending.request)
  expect(auth.useProviderSetup.getState().pending).toBeNull()
  await expect(
    auth.requireProviderAuth({ terminal: { command: 'codex' } }),
  ).resolves.toBeUndefined()
  await expect(
    auth.requireProviderAuth({ terminal: { command: 'codex -p work' } }),
  ).rejects.toThrow()
})
test('simultaneous blocked providers retain the first setup selection', async () => {
  vi.mocked(ipc.agentProvider).mockImplementation(async (t) =>
    t.command === 'claude' ? 'claude' : 'codex',
  )
  await Promise.allSettled([
    auth.requireProviderAuth({ terminal: { command: 'claude' } }),
    auth.requireProviderAuth({ terminal: { command: 'codex' } }),
  ])
  expect(auth.useProviderSetup.getState().pending?.request.provider).toBe('claude')
})
test('running sessions can resume without another authentication check', async () => {
  useStore.setState({ sessions: { live: { running: true } as never } })
  await auth.authenticateInvocation('session_resume', { sessionId: 'live' })
  expect(ipc.agentProvider).not.toHaveBeenCalled()
  expect(ipc.providerAuthCheck).not.toHaveBeenCalled()
})
test('local-model configurations launch without prompting for provider sign-in', async () => {
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue(result('notRequired'))
  await expect(
    auth.requireProviderAuth({ terminal: { command: 'codex --oss --local-provider ollama' } }),
  ).resolves.toBeUndefined()
  expect(auth.useProviderSetup.getState().pending).toBeNull()
})

test('signed-out Codex with a local config can explicitly continue on the next click', async () => {
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue({
    ...result('signedOut'),
    canContinue: true,
  })
  const launch = vi.fn()
  const terminal = { command: "env CODEX_HOME='/tmp/local config' codex" }
  const action = async () => {
    await auth.requireProviderAuth({ terminal })
    launch()
  }
  await expect(action()).rejects.toThrow(auth.ProviderSetupRequired)
  const pending = auth.useProviderSetup.getState().pending!
  expect(pending.result).toMatchObject({ state: 'signedOut', canContinue: true })
  auth.continueProviderSetup(pending.request)
  expect(launch).not.toHaveBeenCalled()
  await action()
  expect(launch).toHaveBeenCalledOnce()
  await expect(
    auth.requireProviderAuth({ terminal: { command: 'codex -p other' } }),
  ).rejects.toThrow(auth.ProviderSetupRequired)
})

test('scheduled authentication reports setup requirements without opening a dialog', async () => {
  vi.mocked(ipc.providerAuthCheck).mockResolvedValue(result('signedOut'))
  await expect(auth.requireProviderAuth({ terminal: { command: 'codex' } }, false)).rejects.toThrow(
    auth.ProviderSetupRequired,
  )
  expect(auth.useProviderSetup.getState().pending).toBeNull()
})
