import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { diffGutterSize, type ParsedDiff } from '../../lib/diff'
import { diffRows, diffTextWidth, firstDiffRow } from '../../lib/diffWindow'

/** Render a bounded range of the received patch, including overscan. */
export default function WindowedDiff({
  parsed,
  lineFocus,
}: {
  parsed: ParsedDiff
  lineFocus?: number
}) {
  const host = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => diffRows(parsed), [parsed])
  const gutter = useMemo(() => diffGutterSize(parsed), [parsed])
  const focused = useRef<{ rows: typeof rows; line: number } | undefined>(undefined)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const width = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return 1000
    const style = getComputedStyle(document.documentElement)
    const mono = style.getPropertyValue('--mono')
    const sans = style.getPropertyValue('--sans')
    return (
      Math.ceil(
        rows.reduce((max, row) => {
          context.font = row.line
            ? `${row.line.kind === 'note' ? 'italic ' : ''}12px ${mono}`
            : `11px ${sans}`
          const measure = (text: string) => context.measureText(text).width
          return Math.max(max, diffTextWidth(row.line?.text ?? row.label, measure))
        }, 0),
      ) + 52 // Code padding and hunk padding, in addition to the grid columns below.
    )
  }, [rows])
  useEffect(() => {
    const element = host.current!
    const scroll = element.closest<HTMLElement>('.diff-view')!
    const measure = () => {
      setViewport({
        top: scroll.getBoundingClientRect().top - element.getBoundingClientRect().top,
        height: scroll.clientHeight,
      })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(scroll)
    scroll.addEventListener('scroll', measure, { passive: true })
    measure()
    return () => {
      observer.disconnect()
      scroll.removeEventListener('scroll', measure)
    }
  }, [])
  useEffect(() => {
    if (lineFocus === undefined) return
    const row =
      rows.find((r) => r.line?.new === lineFocus) ?? rows.find((r) => r.line?.old === lineFocus)
    const element = host.current
    const scroll = element?.closest<HTMLElement>('.diff-view')
    if (!row || !element || !scroll) return
    scroll.scrollTop +=
      element.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      row.offset -
      scroll.clientHeight / 2
    setViewport({ top: row.offset - scroll.clientHeight / 2, height: scroll.clientHeight })
  }, [lineFocus, rows])
  useEffect(() => {
    if (
      lineFocus === undefined ||
      (focused.current?.rows === rows && focused.current.line === lineFocus)
    )
      return
    const element = host.current
    const target =
      element?.querySelector<HTMLElement>(`[data-new-line="${lineFocus}"]`) ??
      element?.querySelector<HTMLElement>(`[data-old-line="${lineFocus}"]`)
    if (target) {
      target.focus({ preventScroll: true })
      focused.current = { rows, line: lineFocus }
    }
  }, [lineFocus, rows, viewport])
  const first = Math.max(0, firstDiffRow(rows, viewport.top) - 20)
  let end = first
  while (end < rows.length && rows[end].offset < viewport.top + viewport.height) end++
  end = Math.min(rows.length, end + 20)
  const total = rows.at(-1)!.offset + rows.at(-1)!.height
  return (
    <div
      ref={host}
      className="diff windowed-diff"
      role="table"
      aria-label="File changes"
      aria-rowcount={rows.length}
      style={
        {
          '--gutter': `${gutter}ch`,
          minWidth: `calc(${width}px + ${2 * gutter + 2}ch)`,
          tabSize: 8,
        } as CSSProperties
      }
    >
      <div aria-hidden="true" style={{ height: rows[first]?.offset ?? 0 }} />
      {rows.slice(first, end).map((row, i) =>
        row.line ? (
          <div
            key={first + i}
            role="row"
            tabIndex={-1}
            aria-rowindex={first + i + 1}
            className={`diff-row ${row.line.kind}`}
            style={{ height: row.height }}
            data-new-line={row.line.new}
            data-old-line={row.line.old}
          >
            <span role="cell" className="diff-num old">
              {row.line.old ?? ''}
            </span>
            <span role="cell" className="diff-num new">
              {row.line.new ?? ''}
            </span>
            <span role="cell" className="diff-sign">
              {row.line.kind === 'add' ? '+' : row.line.kind === 'del' ? '−' : ''}
            </span>
            <span role="cell" className="diff-code">
              {row.line.text || ' '}
            </span>
          </div>
        ) : (
          <div
            key={first + i}
            role="row"
            tabIndex={-1}
            aria-rowindex={first + i + 1}
            className="diff-hunk"
            style={{ height: row.height, marginTop: 0, boxSizing: 'border-box' }}
          >
            <span role="cell">{row.label}</span>
          </div>
        ),
      )}
      <div aria-hidden="true" style={{ height: total - (rows[end]?.offset ?? total) }} />
    </div>
  )
}
