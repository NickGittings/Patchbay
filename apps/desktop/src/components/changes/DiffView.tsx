import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { stepKey } from '../../lib/changeNav'
import { hunkRange, parsePatch } from '../../lib/diff'
import { componentPaths } from '../../lib/git'
import { gitDiff } from '../../lib/ipc'
import { KIND_LABEL, splitPath } from '../../lib/review'
import type { ChangedFile, FileDiff } from '../../types'
import DiffStat from './DiffStat'

/** Rendering more lines than this makes scrolling sluggish; the rest is summarized. */
const MAX_LINES = 5000

/** Where the shown file sits among the listed changes, and how to move to a neighbour. */
export interface DiffNav {
  /** Zero-based; -1 when the shown file isn't listed. */
  position: number
  total: number
  step: (delta: -1 | 1) => void
}

function NavButtons({ nav }: { nav: DiffNav }) {
  const { position, total, step } = nav
  return (
    <span className="diff-nav" role="group" aria-label="Changed files">
      <button
        title="Previous changed file (←)"
        aria-label="Previous changed file"
        disabled={position === 0 || total === 0}
        onClick={() => step(-1)}
      >
        ‹
      </button>
      <span className="diff-nav-count">
        {position < 0 ? '–' : position + 1} / {total}
      </span>
      <button
        title="Next changed file (→)"
        aria-label="Next changed file"
        disabled={position === total - 1 || total === 0}
        onClick={() => step(1)}
      >
        ›
      </button>
    </span>
  )
}

function FileHeader({
  file,
  added,
  removed,
  nav,
}: {
  file: ChangedFile
  added?: number
  removed?: number
  nav?: DiffNav
}) {
  const [dir, name] = splitPath(file.path)
  return (
    <div className="diff-file-header">
      <span className={`kind-pill kind-${file.kind}`}>{KIND_LABEL[file.kind]}</span>
      <span className="diff-file-path" title={file.path}>
        {file.oldPath && <span className="change-old">{file.oldPath} → </span>}
        <span className="path-dir">{dir}</span>
        <span className="path-name">{name}</span>
      </span>
      <DiffStat added={added ?? file.added} removed={removed ?? file.removed} bar />
      {nav && nav.total > 1 && <NavButtons nav={nav} />}
    </div>
  )
}

/**
 * The diff of one changed file against `HEAD`, with old and new line numbers. `revision` changes
 * on every Git refresh, so an edit that leaves the file list unchanged still reloads the diff.
 */
export default function DiffView({
  componentId,
  file,
  revision,
  worktree,
  lineFocus,
  nav,
}: {
  lineFocus?: number
  /** Previous/next buttons in the header, and ←/→ while the diff has focus. */
  nav?: DiffNav
  componentId: string
  file: ChangedFile | null
  revision: unknown
  /** A worktree path from `gitWorktrees`; omitted for the open one. */
  worktree?: string
}) {
  const focusHost = useRef<HTMLDivElement>(null)
  const path = file?.path
  const oldPath = file?.oldPath
  const [diff, setDiff] = useState<{ key: string; diff: FileDiff } | null>(null)
  // Keyed like the diff, so one file's error never shows under another's header.
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null)
  const key = `${worktree ?? ''}\0${path ?? ''}`
  useEffect(() => {
    if (!path) return
    let disposed = false
    void gitDiff(componentPaths(), componentId, path, oldPath, worktree)
      .then((d) => {
        if (!disposed) {
          setDiff({ key, diff: d })
          setFailure(null)
        }
      })
      .catch((e) => {
        if (!disposed) setFailure({ key, error: String(e) })
      })
    return () => {
      disposed = true
    }
  }, [componentId, path, oldPath, worktree, key, revision])

  const loaded = diff?.key === key ? diff.diff : null
  const error = failure?.key === key ? failure.error : ''
  const parsed = useMemo(
    () => (loaded && !loaded.binary ? parsePatch(loaded.patch) : null),
    [loaded],
  )

  useEffect(() => {
    if (lineFocus !== undefined && loaded)
      focusHost.current
        ?.querySelector(`[data-new-line="${lineFocus}"]`)
        ?.scrollIntoView({ block: 'center' })
  }, [lineFocus, loaded])
  if (!file) return <div className="diff-view hint">Select a file to see its changes.</div>
  const body = () => {
    if (error) return <div className="hint diff-error">{error}</div>
    // Keep showing the previous diff until the new one arrives only if it is the same file.
    if (!loaded) return <div className="hint">Loading diff…</div>
    if (loaded.binary) return <div className="hint">Binary file changed.</div>
    if (!parsed?.hunks.length) return <div className="hint">No textual changes.</div>
    let budget = MAX_LINES
    let maxNo = 0
    for (const h of parsed.hunks) {
      maxNo = Math.max(maxNo, h.oldStart + h.oldLines, h.newStart + h.newLines)
    }
    const gutter = { '--gutter': `${String(maxNo).length + 2}ch` } as CSSProperties
    const cut = loaded.truncated || parsed.hunks.reduce((n, h) => n + h.lines.length, 0) > MAX_LINES
    return (
      <>
        <div className="diff" style={gutter} role="table">
          {parsed.hunks.map((h, i) => {
            if (budget <= 0) return null
            const lines = h.lines.slice(0, budget)
            budget -= lines.length
            return (
              <Fragment key={i}>
                <div className="diff-hunk" role="row">
                  <span className="diff-hunk-range">{hunkRange(h)}</span>
                  {h.context && <span className="diff-hunk-context">{h.context}</span>}
                </div>
                {lines.map((l, j) => (
                  <div key={j} className={`diff-row ${l.kind}`} role="row" data-new-line={l.new}>
                    <span className="diff-num old">{l.old ?? ''}</span>
                    <span className="diff-num new">{l.new ?? ''}</span>
                    <span className="diff-sign">
                      {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
                    </span>
                    <span className="diff-code">{l.text || ' '}</span>
                  </div>
                ))}
              </Fragment>
            )
          })}
        </div>
        {cut && <div className="hint">Diff truncated — open the file to see everything.</div>}
      </>
    )
  }
  // A truncated patch undercounts, so prefer the file list's counts then.
  const counts = parsed && !loaded?.truncated ? parsed : undefined
  return (
    // Focusable (not a tab stop) so a click into the diff lets ←/→ switch files.
    <div
      ref={focusHost}
      className={`diff-view ${loaded || error ? '' : 'diff-loading'}`}
      tabIndex={nav ? -1 : undefined}
      onKeyDown={(e) => {
        const delta = nav && stepKey(e, 'diff')
        if (!delta) return
        e.preventDefault()
        nav.step(delta)
      }}
    >
      <FileHeader file={file} added={counts?.added} removed={counts?.removed} nav={nav} />
      {body()}
    </div>
  )
}
