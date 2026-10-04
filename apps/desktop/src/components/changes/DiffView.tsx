import { useEffect, useState } from 'react'
import { componentPaths } from '../../lib/git'
import { gitDiff } from '../../lib/ipc'
import type { ChangedFile, FileDiff } from '../../types'

/** Rendering more lines than this makes scrolling sluggish; the rest is summarized. */
const MAX_LINES = 5000

function lineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('\\')) return 'meta'
  return /^(diff |index |new file|deleted file|old mode|new mode|similarity|rename |copy )/.test(
    line,
  )
    ? 'meta'
    : ''
}

/**
 * The diff of one changed file against `HEAD`. `revision` changes on every Git refresh, so an
 * edit that leaves the file list unchanged still reloads the diff.
 */
export default function DiffView({
  componentId,
  file,
  revision,
}: {
  componentId: string
  file: ChangedFile | null
  revision: unknown
}) {
  const path = file?.path
  const [diff, setDiff] = useState<{ path: string; diff: FileDiff } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!path) return
    let disposed = false
    void gitDiff(componentPaths(), componentId, path)
      .then((d) => {
        if (!disposed) {
          setDiff({ path, diff: d })
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [componentId, path, revision])

  if (!file) return <div className="diff-view hint">Select a file to see its changes.</div>
  if (error) return <div className="diff-view hint diff-error">{error}</div>
  // Keep showing the previous file's diff until the new one arrives only if it is the same file.
  if (!diff || diff.path !== file.path)
    return <div className="diff-view hint diff-loading">Loading diff…</div>
  const { patch, binary, truncated } = diff.diff
  if (binary) return <div className="diff-view hint">Binary file changed.</div>
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length) return <div className="diff-view hint">No textual changes.</div>
  const shown = lines.slice(0, MAX_LINES)
  return (
    <div className="diff-view">
      <pre className="diff">
        {shown.map((line, i) => (
          <div key={i} className={`diff-line ${lineClass(line)}`}>
            {line || ' '}
          </div>
        ))}
      </pre>
      {(truncated || lines.length > shown.length) && (
        <div className="hint">Diff truncated — open the file to see everything.</div>
      )}
    </div>
  )
}
