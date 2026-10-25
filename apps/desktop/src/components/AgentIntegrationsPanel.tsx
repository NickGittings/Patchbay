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
    <div className="extension-overlay" onClick={onClose}>
      <div
        className="extensions-panel panel"
        role="dialog"
        aria-modal="true"
        aria-label="Agent status integration"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row">
          <h2>Agent status integration</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p>
          Install optional status hooks to show Working, Needs input, and Ready for review. Hooks
          report only inside Patchbay and leave provider approvals to you. Claude hooks also pass
          native plans to Patchbay when Claude presents them for approval.
        </p>
        <label>
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
          <label>
            User hook source
            <input
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
        <p>
          If your terminal sets CLAUDE_CONFIG_DIR or CODEX_HOME, check that this path matches that
          provider’s active user configuration.
        </p>
        {result && (
          <>
            <p role="status">
              {result.reportingSessions
                ? `Reporting confirmed in ${result.reportingSessions} running session(s).`
                : 'Reporting has not been confirmed in a running session; Active/Quiet remains the fallback.'}
            </p>
            <p>
              {result.installed ? 'Status hooks installed.' : 'Status hooks are not installed.'}{' '}
              {result.disabled && 'Hooks are disabled in this source.'}{' '}
              {result.installed &&
                !result.reporterAvailable &&
                'The installed reporter is missing; reinstall status hooks.'}
            </p>
            {result.guidance.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="row">
          <button disabled={busy} onClick={() => void perform()}>
            Check integration
          </button>
          <button disabled={busy} onClick={() => void perform(true)}>
            Install status hooks
          </button>
          <button disabled={busy} onClick={() => void perform(false)}>
            Remove status hooks
          </button>
        </div>
      </div>
    </div>
  )
}
