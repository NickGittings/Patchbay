import ProviderAuthSection from './ProviderAuthSection'
import type { AuthRequest } from '../lib/providerAuth'
import { useStore } from '../store'
import { decodeProfile } from '../lib/agentProfiles'
import SettingsDialog, { SettingsFeedback, SettingsSection } from './SettingsDialog'
import { useEffect, useRef, useState } from 'react'
import { agentHooksCheck, agentHooksConfigure } from '../lib/ipc'
import { hookSource, rememberAgentHooks, setHookSource, type HookProvider } from '../lib/agentHooks'
import type { AgentIntegration } from '../types'

export default function AgentIntegrationsPanel({
  initialProvider,
  onClose,
}: {
  initialProvider?: HookProvider
  onClose: () => void
}) {
  const [provider, setProvider] = useState<HookProvider>(initialProvider ?? 'claude')
  const [source, setSource] = useState('')
  const [result, setResult] = useState<AgentIntegration>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const request = useRef(0)
  useEffect(() => {
    const token = ++request.current
    let canceled = false
    const current = () => !canceled && token === request.current
    const chosen = hookSource(provider)
    const check = agentHooksCheck(provider, chosen)
    void check
      .then((value) => {
        if (!current()) return
        setResult(value)
        setSource(value.source)
        rememberAgentHooks(provider, chosen, value)
      })
      .catch((e) => {
        if (!current()) return
        setError(String(e))
        // A remembered source stays in the field even while it can't be read.
        setSource(chosen ?? '')
      })
      .finally(() => {
        if (current()) setBusy(false)
      })
    return () => {
      canceled = true
    }
  }, [provider])
  const perform = async (install?: boolean) => {
    const token = ++request.current
    setBusy(true)
    setError('')
    try {
      const value =
        install === undefined
          ? await agentHooksCheck(provider, source || undefined)
          : await agentHooksConfigure(provider, install, source || undefined)
      if (token === request.current) {
        setResult(value)
        setSource(value.source)
      }
      // The response carries the default path, even when inspecting a custom source.
      if (value.defaultSource !== null)
        setHookSource(
          provider,
          value.source !== value.defaultSource ? value.source : undefined,
          value,
        )
      else if (token === request.current)
        setError('The default hook source couldn’t be read, so Chat and Auto keep their source.')
    } catch (e) {
      if (token === request.current) setError(String(e))
    } finally {
      if (token === request.current) setBusy(false)
    }
  }
  const authRequest: AuthRequest = {
    provider: provider.startsWith('claude') ? 'claude' : 'codex',
    terminal: provider.startsWith('claude:')
      ? (useStore.getState().devices.find((d) => d.command.includes(provider.slice(7))) ?? {
          command: `PATCHBAY_AGENT_PROFILE=${provider.slice(7)} claude`,
        })
      : undefined,
  }
  return (
    <SettingsDialog
      title="Agent providers"
      subtitle="CLI sign-in and status hooks across projects"
      behavior="Sign-in and hook actions apply when selected."
      onClose={onClose}
    >
      <label className="settings-field">
        Provider{' '}
        <select
          value={provider}
          disabled={busy}
          onChange={(e) => {
            setProvider(e.target.value as HookProvider)
            setResult(undefined)
            setSource('')
            setError('')
            setBusy(true)
          }}
        >
          {provider.startsWith('claude:') && (
            <option value={provider}>{decodeProfile(provider.slice(7)).name}</option>
          )}
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <SettingsSection title="CLI sign-in">
        <ProviderAuthSection key={provider} request={authRequest} />
      </SettingsSection>
      <SettingsSection title="Status hooks">
        <p>Hooks can be installed independently of sign-in.</p>
        <p>
          <label className="settings-field">
            User hook source
            <input
              title="Match the provider’s active user configuration, including CLAUDE_CONFIG_DIR or CODEX_HOME overrides."
              aria-label="User hook source"
              value={source}
              disabled={busy || provider.startsWith('claude:')}
              onChange={(e) => {
                setSource(e.target.value)
                setResult(undefined)
              }}
            />
          </label>
        </p>

        {result && (
          <>
            <div className="panel-actions" role="status">
              <span
                className="worktree-tag"
                title="Reporting is confirmed when a running session sends status events."
              >
                {result.reportingSessions
                  ? `${result.reportingSessions} reporting`
                  : 'Reporting unconfirmed'}
              </span>
              <span className="worktree-tag">
                {result.installed ? 'Hooks installed' : 'Hooks not installed'}
              </span>
              {result.disabled && <span className="worktree-tag bad">Hooks disabled</span>}
              {result.installed && !result.reporterAvailable && (
                <span className="worktree-tag bad">Reporter missing</span>
              )}
            </div>
            {result.guidance.map((text) => (
              <SettingsFeedback key={text}>{text}</SettingsFeedback>
            ))}
          </>
        )}
        {busy && <SettingsFeedback>Checking integration…</SettingsFeedback>}
        {error && <SettingsFeedback error>{error}</SettingsFeedback>}
        <div className="settings-actions">
          <button disabled={busy} onClick={() => void perform()}>
            Check integration
          </button>

          <button className="danger" disabled={busy} onClick={() => void perform(false)}>
            Remove status hooks
          </button>
          <button className="primary" disabled={busy} onClick={() => void perform(true)}>
            Install status hooks
          </button>
        </div>
      </SettingsSection>
    </SettingsDialog>
  )
}
