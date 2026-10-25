import { useEffect } from 'react'
import { create } from 'zustand'
import { useStore } from '../store'
import type { AgentIntegration, TerminalSpec } from '../types'
import { agentHooksCheck, agentProvider } from './ipc'
import { useRail } from './rail'

export type HookProvider = 'claude' | 'codex'

/** Installed, enabled and with their reporter present: the only hooks that report status. */
export const hooksUsable = (
  hooks: Pick<AgentIntegration, 'installed' | 'disabled' | 'reporterAvailable'>,
) => hooks.installed && !hooks.disabled && hooks.reporterAvailable

/**
 * The "User hook source" the integrations dialog last used for `provider`, when it isn't the
 * provider's default. It lives in the workspace settings, so every later check (the chat's
 * notices, Auto's start) reads the file the hooks were installed in.
 */
export function hookSource(provider: HookProvider): string | undefined {
  const sources = useStore.getState().workspaceSettings.hookSources
  const source =
    sources && typeof sources === 'object'
      ? (sources as Record<string, unknown>)[provider]
      : undefined
  return typeof source === 'string' && source ? source : undefined
}
/** Remembers `source` for `provider`; `undefined` (or empty) returns to the default. */
export function setHookSource(
  provider: HookProvider,
  source: string | undefined,
  result?: AgentIntegration,
) {
  if (hookSource(provider) === (source || undefined)) {
    if (result) rememberAgentHooks(provider, source || undefined, result)
    return
  }
  if (result) {
    ++requests[provider]
    inflight.delete(provider)
    checked[provider] = { key: `${provider}\0${source ?? ''}`, atMs: Date.now() }
    useAgentHooks.setState({ [provider]: hooksUsable(result) })
  }
  useStore.setState((s) => {
    const previous = s.workspaceSettings.hookSources
    const sources: Record<string, unknown> = {
      ...(previous && typeof previous === 'object' ? previous : {}),
    }
    if (source) sources[provider] = source
    else delete sources[provider]
    return { workspaceSettings: { ...s.workspaceSettings, hookSources: sources } }
  })
}
/** Checks `provider`'s hooks in the source the user chose for it. */
export const checkHooks = (provider: HookProvider) =>
  agentHooksCheck(provider, hookSource(provider))

/**
 * Restored hook sources, keeping each provider's source the user changed while the workspace was
 * restoring (`current` differs from the `initial` value the store started with); `undefined`
 * when neither has any.
 */
export function mergeRestoredHookSources(
  saved: unknown,
  current: unknown,
  initial: unknown,
): Record<string, unknown> | undefined {
  const record = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const merged = { ...record(saved) }
  const now = record(current),
    before = record(initial)
  for (const key of new Set([...Object.keys(now), ...Object.keys(before)]))
    if (now[key] !== before[key]) {
      if (now[key] === undefined) delete merged[key]
      else merged[key] = now[key]
    }
  const savedAny = record(saved) === saved
  return savedAny || Object.keys(merged).length ? merged : undefined
}

/**
 * What a provider's status hooks check found: usable, not (missing, disabled or without their
 * reporter), or `'failed'` when the configuration couldn't be read, which a later check may fix.
 */
export type HooksCheck = boolean | 'failed'
/**
 * Each provider's hooks, as Settings → Agent status integration reports them; absent until
 * checked. A session's `authoritative` flag can't answer this: it lapses on Esc or a permission
 * answer and stays unset until a startup's first hook. Hooks may still report inside a session
 * whose login shell points the provider at another configuration, so only a session that has
 * not reported is ever refused on this (`composerStatus`).
 */
export const useAgentHooks = create<Partial<Record<HookProvider, HooksCheck>>>(() => ({}))
/** How long a check answers later mounts before they ask again. */
export const HOOKS_FRESH_MS = 30_000
const requests: Record<HookProvider, number> = { claude: 0, codex: 0 }
const inflight = new Map<HookProvider, { key: string; promise: Promise<void> }>()
const checked: Partial<Record<HookProvider, { key: string; atMs: number }>> = {}
/**
 * Checks `provider`'s hooks in its chosen source. Callers share a check in flight, and a fresh
 * answer for the same source, unless `force` asks again; the newest check for the current source wins.
 */
export function refreshAgentHooks(provider: HookProvider, force = false): Promise<void> {
  const source = hookSource(provider)
  const key = `${provider}\0${source ?? ''}`
  const running = inflight.get(provider)
  if (!force && running?.key === key) return running.promise
  const last = checked[provider]
  if (
    !force &&
    last?.key === key &&
    Date.now() - last.atMs < HOOKS_FRESH_MS &&
    // A failed check is never fresh: the next mount asks again.
    [true, false].includes(useAgentHooks.getState()[provider] as boolean)
  )
    return Promise.resolve()
  const token = ++requests[provider]
  if (last?.key !== key) useAgentHooks.setState({ [provider]: undefined })
  const check = (async () => {
    let result: HooksCheck
    try {
      result = hooksUsable(await agentHooksCheck(provider, source))
    } catch {
      // The dialog shows the error itself.
      result = 'failed'
    }
    if (token === requests[provider] && hookSource(provider) === source) {
      checked[provider] = { key, atMs: Date.now() }
      useAgentHooks.setState({ [provider]: result })
    }
  })()
  inflight.set(provider, { key, promise: check })
  void check.finally(() => {
    if (inflight.get(provider)?.promise === check) inflight.delete(provider)
  })
  return check
}
/** Reuse the dialog's completed check/configure result without issuing another request. */
export function rememberAgentHooks(
  provider: HookProvider,
  source: string | undefined,
  value: AgentIntegration,
) {
  if (hookSource(provider) !== source) return
  ++requests[provider]
  inflight.delete(provider)
  checked[provider] = { key: `${provider}\0${source ?? ''}`, atMs: Date.now() }
  useAgentHooks.setState({ [provider]: hooksUsable(value) })
}
/** A native provider report remains evidence of hooks after Esc revokes its readiness. */
export const sessionReportedHooks = (session: import('../types').SessionState | undefined) =>
  !!session?.running && !!session.status?.agent?.provider

const refreshKnown = (force: boolean) => {
  for (const provider of Object.keys(useAgentHooks.getState()) as HookProvider[])
    void refreshAgentHooks(provider, force)
}
// Another source answers for another file; a restored workspace may bring one.
useStore.subscribe((s, previous) => {
  if (s.workspaceSettings.hookSources !== previous.workspaceSettings.hookSources)
    refreshKnown(false)
})
// Hooks installed elsewhere, or a configuration fixed after a failed check.
if (typeof window !== 'undefined') window.addEventListener('focus', () => refreshKnown(false))

/**
 * The first of `providers` whose hooks a chat notice should ask for, with what the check found;
 * providers whose sessions already report (`reporting`) evidently have working hooks.
 */
export function missingHooks(
  providers: readonly HookProvider[],
  hooks: Partial<Record<HookProvider, HooksCheck>>,
  reporting: ReadonlySet<HookProvider> = new Set(),
): { provider: HookProvider; check: false | 'failed' } | undefined {
  for (const provider of providers) {
    const check = hooks[provider]
    if (!reporting.has(provider) && (check === false || check === 'failed'))
      return { provider, check }
  }
  return undefined
}

/** The rail's settings value that opens the integrations dialog, on `provider` if given. */
export const integrationsSetting = (provider?: HookProvider) =>
  provider ? `integrations:${provider}` : 'integrations'
/**
 * Whether `setting` opens the integrations dialog: the provider it opens on, `null` for the
 * default one, `undefined` for any other setting.
 */
export function integrationsProvider(setting: string | null): HookProvider | null | undefined {
  if (setting === 'integrations') return null
  const provider = setting?.match(/^integrations:(claude|codex)$/)?.[1]
  return provider ? (provider as HookProvider) : undefined
}
export function openIntegrations(provider?: HookProvider) {
  useRail.setState({ settings: integrationsSetting(provider) })
}
// The integrations dialog may have installed or removed hooks, or chosen another source.
useRail.subscribe((s, previous) => {
  if (
    integrationsProvider(previous.settings) !== undefined &&
    integrationsProvider(s.settings) === undefined
  )
    refreshKnown(false)
})
/** Checks `providers` on mount and whenever they change (sharing fresh checks); `undefined` while unknown. */
export function useAgentHooksInstalled(providers: readonly HookProvider[]) {
  const key = [...new Set(providers)].sort().join(',')
  useEffect(() => {
    for (const provider of key ? (key.split(',') as HookProvider[]) : [])
      void refreshAgentHooks(provider)
  }, [key])
  return useAgentHooks()
}

type Preset = Pick<TerminalSpec, 'command' | 'adapter'>
/**
 * Providers of preset commands without an explicit `adapter`, inferred by the backend as session
 * records and Auto infer them (`agent_provider`); `null` for neither Claude nor Codex.
 */
export const useInferredProviders = create<Record<string, HookProvider | null>>(() => ({}))
const inferring = new Set<string>()
export async function inferProvider(command: string) {
  if (command in useInferredProviders.getState() || inferring.has(command)) return
  inferring.add(command)
  try {
    const provider = await agentProvider({ command })
    useInferredProviders.setState({ [command]: provider })
  } catch {
    // Still unknown; a later mount asks again.
  } finally {
    inferring.delete(command)
  }
}
/** `preset`'s provider: its `adapter`, else the inferred one; `undefined` while unknown. */
export function presetProvider(
  preset: Preset | undefined,
  inferred: Record<string, HookProvider | null>,
): HookProvider | null | undefined {
  if (!preset) return undefined
  return preset.adapter ?? inferred[preset.command]
}
/** Each of `presets`' providers, inferring those without an `adapter`. */
export function usePresetProviders(presets: readonly (Preset | undefined)[]) {
  const inferred = useInferredProviders()
  const key = JSON.stringify([
    ...new Set(presets.flatMap((p) => (p && !p.adapter ? [p.command] : []))),
  ])
  useEffect(() => {
    for (const command of JSON.parse(key) as string[]) void inferProvider(command)
  }, [key])
  return presets.map((p) => presetProvider(p, inferred))
}
