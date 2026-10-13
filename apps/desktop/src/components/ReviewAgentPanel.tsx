import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { terminalStatus } from '../lib/display'
import { terminalStop } from '../lib/ipc'
import { reviewAgentRecords } from '../lib/reviewAgents'
import { fixReviewFindings } from '../lib/reviewHandoff'
import { useStore } from '../store'
import { REVIEW_SCOPE, type SessionRecord, type TerminalSpec } from '../types'
import { useReviewFindings, type LoadedFindings } from '../lib/useReviewFindings'
import TerminalPane from './TerminalPane'
import StatusLabel from './status/StatusLabel'

export default function ReviewAgentPanel({
  selected,
  select,
  hide,
  sourceBranch,
  sourceFindings,
}: {
  selected: SessionRecord
  select: (sid: string) => void
  hide: () => void
  /** Review already polls the source branch's findings; reuse them for that branch. */
  sourceBranch?: string | null
  sourceFindings?: LoadedFindings
}) {
  const records = useStore(
    useShallow((s) => reviewAgentRecords(s.sessionRecords, selected.metadata.projectId)),
  )
  const session = useStore((s) => s.sessions[selected.id])
  const isReview = selected.metadata.componentId === REVIEW_SCOPE
  const [findings, setFindings] = useState(false)
  const branch = selected.metadata.branch ?? undefined
  const shared = !!branch && branch === sourceBranch
  // Poll while the panel is shown so the fix handoff can use findings before the toggle opens.
  const own = useReviewFindings(
    selected.metadata.projectId,
    isReview && !shared ? branch : undefined,
  )
  const loaded = shared ? sourceFindings : own
  const [stopping, setStopping] = useState(false)
  const [starting, setStarting] = useState(false)
  const terminal: TerminalSpec = {
    id: selected.metadata.terminalId,
    name: selected.metadata.name,
    kind: 'agent',
    command: selected.spec.command,
  }
  return (
    <section
      className="review-merge-terminal"
      aria-label={isReview ? 'Review agent terminal' : 'Merge agent terminal'}
      data-session={selected.id}
    >
      <header className="terminal-tile-header">
        <strong>{isReview ? 'Review agent' : 'Merge agent'}</strong>
        <select
          aria-label="Agent session"
          value={selected.id}
          onChange={(e) => select(e.target.value)}
        >
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {r.metadata.name}
            </option>
          ))}
        </select>
        <StatusLabel status={terminalStatus('agent', session)} />
        <span className="spacer" />
        {isReview && branch && (
          <button
            disabled={starting || !!session?.running || !loaded?.findings?.text.trim()}
            title={
              session?.running
                ? 'Wait for the review to finish; findings may still be partial'
                : 'Start a fresh agent in the reviewed worktree to address the findings'
            }
            onClick={() => {
              setStarting(true)
              void fixReviewFindings(selected)
                .catch((e) => useStore.getState().setMessage(String(e)))
                .finally(() => setStarting(false))
            }}
          >
            {starting ? 'Starting…' : 'Fix in Implementation →'}
          </button>
        )}
        {isReview && (
          <button aria-pressed={findings} onClick={() => setFindings(!findings)}>
            Findings
          </button>
        )}
        {session?.running && (
          <button
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void terminalStop(selected.id)
                .catch((e) => useStore.getState().setMessage(String(e)))
                .finally(() => setStopping(false))
            }}
          >
            {stopping ? 'Stopping…' : '■ Stop'}
          </button>
        )}
        <button onClick={hide} title="Hide panel; the agent keeps running">
          Hide
        </button>
      </header>
      <div className="review-merge-location" title={selected.spec.cwd}>
        {selected.spec.cwd}
      </div>
      {isReview && findings ? (
        <div className="review-findings" aria-label="Review findings">
          {loaded?.error ? (
            <p role="alert">{loaded.error}</p>
          ) : (
            <pre>
              {!selected.metadata.branch
                ? 'This session predates recorded review branches; findings are shown in Review.'
                : loaded
                  ? (loaded.findings?.text ?? 'No findings saved yet.')
                  : 'Loading…'}
            </pre>
          )}
          {loaded?.findings?.truncated && <p className="hint">Findings truncated at 64 KiB.</p>}
        </div>
      ) : (
        <TerminalPane
          componentId={selected.metadata.componentId}
          terminal={terminal}
          existingSessionId={selected.id}
          task={null}
        />
      )}
    </section>
  )
}
