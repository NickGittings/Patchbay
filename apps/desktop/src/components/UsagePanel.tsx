import { useState } from 'react'
import { useStore } from '../store'
import { useClockTick } from '../lib/clock'
import { usageStatusLineConfigure } from '../lib/ipc'
import {
  parseThreshold,
  providerName,
  refreshUsage,
  resetLabel,
  resetsIn,
  usageAge,
  usageLevel,
  useUsage,
  USAGE_PROVIDERS,
  USAGE_WINDOWS,
  windowName,
} from '../lib/usage'

/** Commits on blur or Enter, so a half-typed value never warns, uses up an alert or gates Auto. */
function ThresholdInput({ value, onCommit }: { value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const parsed = parseThreshold(draft)
    setDraft(null)
    if (parsed !== null && parsed !== value) onCommit(parsed)
  }
  return (
    <input
      type="number"
      min={1}
      max={100}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setDraft(null)
      }}
    />
  )
}

export default function UsagePanel() {
  useClockTick()
  const usage = useUsage((s) => s.usage)
  const error = useUsage((s) => s.error)
  const [refreshing, setRefreshing] = useState(false)
  const settings = useStore((s) => s.usageSettings)
  const setSettings = useStore((s) => s.setUsageSettings)
  const [busy, setBusy] = useState(false)
  const capture = usage?.claudeCapture
  // Relative reset times intentionally advance with the shared clock tick.
  // oxlint-disable-next-line react/purity
  const now = Date.now()
  return (
    <div className="usage-panel">
      <p className="usage-note">Subscription limits across all projects and agent sessions.</p>
      {error && <p role="alert">{error}</p>}
      {!usage && !error && <p role="status">Reading local usage…</p>}
      {USAGE_PROVIDERS.map((provider) => {
        const data = usage?.[provider]
        const hasWindows = USAGE_WINDOWS.some((key) => (data?.[key]?.resetsAtMs ?? 0) > now)
        const providerError = provider === 'claude' ? usage?.claudeError : usage?.codexError
        return (
          <section
            className="panel-section"
            key={provider}
            aria-label={`${providerName(provider)} usage`}
          >
            <h3>{providerName(provider)}</h3>
            {providerError && <p role="alert">{providerError}</p>}
            {USAGE_WINDOWS.map((key) => {
              const w = data?.[key]
              const valid = w && w.resetsAtMs > now
              const name = windowName(key)
              const label = name[0].toUpperCase() + name.slice(1)
              return (
                <div
                  className="usage-window"
                  key={key}
                  data-level={valid ? usageLevel(w, settings) : 'ok'}
                >
                  <div className="usage-window-label">
                    <span>{label}</span>
                    <strong>{valid ? `${Math.round(w.usedPercent)}%` : '—'}</strong>
                  </div>
                  <progress
                    aria-label={`${providerName(provider)} ${label} usage`}
                    max={100}
                    value={valid ? w.usedPercent : 0}
                  />
                  <small>
                    {valid
                      ? `Resets in ${resetsIn(w.resetsAtMs, now)} · ${resetLabel(w.resetsAtMs, now)}`
                      : 'No current window reported'}
                  </small>
                </div>
              )
            })}
            {data && (
              <p className="usage-note" title={new Date(data.observedMs).toLocaleString()}>
                {usageAge(data.observedMs, now)}
              </p>
            )}
            {usage && !hasWindows && !providerError && (
              <p className="usage-note">
                {provider === 'claude'
                  ? !capture?.installed
                    ? 'Install capture to read Claude usage.'
                    : 'No current usage yet. Start an interactive Pro or Max session and wait for a response. Other plans may not report limits.'
                  : 'No current usage in local Codex session logs. Start a Codex session to report limits.'}
              </p>
            )}
            {provider === 'claude' && capture && (
              <>
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      const result = await usageStatusLineConfigure(!capture.installed)
                      useUsage.setState((s) => ({
                        usage: s.usage ? { ...s.usage, claudeCapture: result } : null,
                      }))
                      await refreshUsage({ fresh: true })
                    } catch (e) {
                      useStore.getState().setMessage(String(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  {busy
                    ? 'Updating capture…'
                    : capture.installed
                      ? 'Remove Claude capture'
                      : 'Capture Claude usage'}
                </button>
                <p className="usage-note">
                  Capture wraps any existing status line and restores it on removal. Claude usage
                  refreshes only while an interactive session runs.
                </p>
                {capture.chained && (
                  <p className="usage-note">
                    {capture.installed
                      ? 'Wrapping your existing status line.'
                      : 'Your existing status line will keep running.'}
                  </p>
                )}
                <small className="usage-source" title={capture.source}>
                  {capture.source}
                </small>
              </>
            )}
          </section>
        )
      })}
      <section className="panel-section usage-controls" aria-label="Usage thresholds">
        <h3>Thresholds</h3>
        {(
          [
            ['warnPercent', 'Warn at'],
            ['pausePercent', 'Pause Auto at'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <span>
              <ThresholdInput
                value={settings[key]}
                onCommit={(value) =>
                  setSettings({ ...useStore.getState().usageSettings, [key]: value })
                }
              />{' '}
              %
            </span>
          </label>
        ))}
        <label className="usage-check">
          <input
            type="checkbox"
            checked={settings.gateAuto}
            onChange={(e) =>
              setSettings({ ...useStore.getState().usageSettings, gateAuto: e.target.checked })
            }
          />{' '}
          Pause Auto before a stage when a provider reaches its limit threshold
        </label>
        <p className="usage-note">
          Missing or expired windows allow Auto to continue. Resume checks usage again.
        </p>
      </section>
      <section className="rail-actions panel-section" aria-label="Usage actions">
        <div className="section-title">Actions</div>
        <button
          onClick={async () => {
            setRefreshing(true)
            try {
              await refreshUsage()
            } finally {
              setRefreshing(false)
            }
          }}
          disabled={busy || refreshing}
        >
          {refreshing ? 'Refreshing usage…' : 'Refresh usage'}
        </button>
      </section>
    </div>
  )
}
