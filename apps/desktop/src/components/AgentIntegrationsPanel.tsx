import Dialog from './Dialog'
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
  return (
    <Dialog
      title="Agent status integration"
      subtitle="Status hooks for agent sessions"
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
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <p>
        <label className="settings-field">
          User hook source
          <input
            title="Match the provider’s active user configuration, including CLAUDE_CONFIG_DIR or CODEX_HOME overrides."
            aria-label="User hook source"
            value={source}
            disabled={busy}
            onChange={(e) => {
              setSource(e.target.value)
              setResult(undefined)
            }}
            style={{ width: '100%' }}
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
            <p role="alert" key={text}>
              {text}
            </p>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button disabled={busy} onClick={() => void perform()}>
          Check integration
        </button>
        <button className="primary" disabled={busy} onClick={() => void perform(true)}>
          Install status hooks
        </button>
        <button disabled={busy} onClick={() => void perform(false)}>
          Remove status hooks
        </button>
      </div>
    </Dialog>
  )
}
