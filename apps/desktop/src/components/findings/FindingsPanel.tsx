import { useMemo, useState, type ReactNode } from 'react'
import { useClockTick } from '../../lib/clock'
import { parseFindings, SEVERITIES, severityCounts, type FileRef } from '../../lib/findings'
import { ago } from '../../lib/review'
import type { LoadedFindings } from '../../lib/useReviewFindings'
import type { ReviewFindings, Severity } from '../../types'
import Markdown from './Markdown'
import './findings.css'

export type FindingsStatus = 'none' | 'current' | 'stale'

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

function refLabel(ref: FileRef) {
  const name = ref.path.split('/').pop() ?? ref.path
  return ref.line === undefined
    ? name
    : `${name}:${ref.line}${ref.endLine ? `–${ref.endLine}` : ''}`
}

/** The verdict pill: clean, issues, or still pending when no reviewer's verdict reads yet. */
export function VerdictBadge({ findings }: { findings: ReviewFindings | null | undefined }) {
  const verdict = findings?.verdict
  const writing = !!findings?.reviewers.some((r) => !r.finished && !r.error)
  const kind = !verdict ? (writing ? 'writing' : 'unknown') : verdict.clean ? 'clean' : 'issues'
  const label = {
    writing: 'Reviewing…',
    unknown: 'No verdict',
    clean: 'Clean',
    issues: 'Issues',
  }[kind]
  return <span className={`verdict-badge verdict-${kind}`}>{label}</span>
}

/** Nonzero severity counts as compact pills; nothing for a clean or unread verdict. */
export function SeverityCounts({ findings }: { findings: ReviewFindings | null | undefined }) {
  const counts = findings?.verdict?.counts
  if (!counts) return null
  return (
    <span className="severity-counts">
      {SEVERITIES.filter((s) => counts[s] > 0).map((s) => (
        <span key={s} className={`severity-pill severity-${s}`} title={SEVERITY_LABEL[s]}>
          {counts[s]} {s}
        </span>
      ))}
    </span>
  )
}

/**
 * A review's findings as cards: verdict, per-severity filters, each reviewer's findings with their
 * file references (opened through `onOpenFile` when `canOpen` allows), and Markdown bodies.
 */
export default function FindingsPanel({
  loaded,
  status,
  branch,
  onOpenFile,
  canOpen,
  actions,
}: {
  loaded: LoadedFindings | undefined
  /** Whether the findings cover the branch as it is now; unknown outside Review. */
  status?: FindingsStatus
  branch?: string | null
  onOpenFile?: (ref: FileRef) => void
  canOpen?: (path: string) => boolean
  /** Extra header controls, such as the fix handoff. */
  actions?: ReactNode
}) {
  useClockTick()
  const findings = loaded?.findings
  const sections = useMemo(() => parseFindings(findings?.text ?? ''), [findings?.text])
  const parsed = useMemo(() => severityCounts(sections), [sections])
  const [filter, setFilter] = useState<Severity[]>([])
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const counts = findings?.verdict?.counts ?? parsed
  const total = sections.reduce((n, s) => n + s.items.length, 0)
  const keys = sections.flatMap((s, i) => s.items.map((_, j) => `${i}:${j}`))
  const allClosed = keys.length > 0 && keys.every((k) => closed[k])
  const earlier =
    !!findings?.text.trim() &&
    !!findings.reviewers.length &&
    findings.reviewers.every((r) => !r.finished)

  if (!branch)
    return (
      <div className="findings-panel">
        <p className="hint">
          Findings are recorded per branch, and none is recorded here; see Review.
        </p>
      </div>
    )
  if (!loaded)
    return (
      <div className="findings-panel">
        <p className="hint">Loading findings…</p>
      </div>
    )
  if (loaded.error)
    return (
      <div className="findings-panel">
        <p role="alert">{loaded.error}</p>
      </div>
    )
  if (!findings)
    return (
      <div className="findings-panel">
        <div className="review-empty">
          No review of <code>{branch}</code> yet. Use “Review branch…” to start one.
        </div>
      </div>
    )

  return (
    <div className="findings-panel" aria-label="Review findings">
      <header className="findings-header">
        <div className="findings-title-row">
          <VerdictBadge findings={findings} />
          <span className="findings-title">
            {total ? `${total} finding${total === 1 ? '' : 's'}` : 'Findings'}
          </span>
          <span className="findings-meta">
            {status === 'stale' ? 'Changed since review · ' : ''}reviewed {ago(findings.modifiedMs)}{' '}
            against <code>{findings.base}</code>
          </span>
          <span className="spacer" />
          {actions}
        </div>
        {total > 0 && (
          <div className="findings-toolbar" role="toolbar" aria-label="Filter severities">
            <button
              className={`filter-chip ${filter.length ? '' : 'on'}`}
              aria-pressed={!filter.length}
              onClick={() => setFilter([])}
            >
              All
            </button>
            {SEVERITIES.map((s) => (
              <button
                key={s}
                className={`filter-chip ${filter.includes(s) ? 'on' : ''}`}
                aria-pressed={filter.includes(s)}
                disabled={!counts[s] && !parsed[s]}
                onClick={() =>
                  setFilter(filter.includes(s) ? filter.filter((f) => f !== s) : [...filter, s])
                }
              >
                <span className={`severity-dot severity-${s}`} />
                {SEVERITY_LABEL[s]}
                <span className="filter-count">{counts[s]}</span>
              </button>
            ))}
            <span className="spacer" />
            <button
              className="findings-collapse"
              onClick={() =>
                setClosed(allClosed ? {} : Object.fromEntries(keys.map((k) => [k, true])))
              }
            >
              {allClosed ? 'Expand all' : 'Collapse all'}
            </button>
          </div>
        )}
        {(findings.reviewers.length > 1 || findings.reviewers.some((r) => r.error)) && (
          <div className="findings-reviewers" role="status">
            {findings.reviewers.map((r, i) => (
              <span key={`${r.lane}-${i}`} className="findings-reviewer">
                <VerdictBadge findings={{ ...findings, verdict: r.verdict, reviewers: [r] }} />
                {r.lane ?? 'reviewer'}
                {r.error && <span className="hint"> launch unconfirmed: {r.error}</span>}
              </span>
            ))}
          </div>
        )}
        {earlier && (
          <p className="findings-note">
            Showing an earlier attempt’s findings until the current review writes its own.
          </p>
        )}
        {status === 'stale' && !earlier && (
          <p className="findings-note">
            The branch changed after this review; some findings may already be addressed.
          </p>
        )}
        {findings.truncated && <p className="findings-note">Findings truncated at 64 KiB.</p>}
      </header>
      <div className="findings-body">
        {!findings.text.trim() && <p className="hint">No findings saved yet.</p>}
        {sections.map((section, i) => {
          const items = section.items
            .map((f, j) => ({ f, key: `${i}:${j}` }))
            .filter(({ f }) => !filter.length || filter.includes(f.severity))
          if (filter.length && !items.length) return null
          return (
            <section key={i} className="findings-section">
              {section.reviewer !== null && (
                <div className="panel-title findings-section-title">{section.reviewer}</div>
              )}
              {section.intro && !filter.length && (
                <div className="findings-intro">
                  <Markdown text={section.intro} />
                </div>
              )}
              {items.map(({ f, key }) => {
                const open = !closed[key]
                return (
                  <article key={key} className={`finding-card severity-${f.severity}`}>
                    <header className="finding-header">
                      <button
                        className="review-toggle"
                        aria-expanded={open}
                        aria-label={open ? 'Collapse' : 'Expand'}
                        onClick={() => setClosed({ ...closed, [key]: open })}
                      >
                        {open ? '▾' : '▸'}
                      </button>
                      <span className={`severity-pill severity-${f.severity}`}>
                        {SEVERITY_LABEL[f.severity]}
                      </span>
                      <span className="finding-title">
                        <Markdown text={f.title} inline />
                      </span>
                    </header>
                    {f.refs.length > 0 && (
                      <div className="finding-refs">
                        {f.refs.map((ref) => {
                          const openable = !!onOpenFile && (canOpen?.(ref.path) ?? true)
                          return (
                            <button
                              key={`${ref.path}:${ref.line}`}
                              className="finding-ref"
                              disabled={!openable}
                              title={
                                openable
                                  ? `Show ${ref.path} in Review`
                                  : onOpenFile
                                    ? `${ref.path} has no uncommitted changes to show`
                                    : ref.path
                              }
                              onClick={() => onOpenFile?.(ref)}
                            >
                              {refLabel(ref)}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {open && f.body && (
                      <div className="finding-body">
                        <Markdown text={f.body} />
                      </div>
                    )}
                  </article>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
