import { useEffect, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { KIND_COLOR } from '../lib/display'
import { gitReview } from '../lib/ipc'
import { latestChange, latestChangeOf } from '../lib/review'
import { useStore } from '../store'
import type { Review } from '../types'
import ChangeList from './changes/ChangeList'
import DiffView from './changes/DiffView'
import ValidationChips from './changes/ValidationChips'

/**
 * Every uncommitted change on the map, grouped by component, with the components that depend on
 * changed ones and whether each one's task terminals ran since the change.
 */
export default function ReviewView() {
  const revision = useStore((s) => s.gitChanges)
  const nodes = useStore((s) => s.nodes)
  // Selecting or dragging replaces nodes and edges; refetch only when folders or links change.
  const pathsKey = useStore((s) => s.nodes.map((n) => `${n.id}\0${n.data.path}`).join('\n'))
  const linksKey = useStore((s) => s.edges.map((e) => `${e.source}>${e.target}`).join('\n'))
  const select = useStore((s) => s.select)
  const [review, setReview] = useState<Review | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ componentId: string; path: string } | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [refresh, setRefresh] = useState(0)

  useEffect(() => {
    let disposed = false
    void gitReview(useStore.getState().toProject())
      .then((r) => {
        if (!disposed) {
          setReview(r)
          setError('')
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e))
      })
    return () => {
      disposed = true
    }
  }, [revision, pathsKey, linksKey, refresh])

  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.data.name ?? id
  const changed = review ? nodes.filter((n) => review.changes[n.id]?.length) : []
  const fileCount = changed.reduce((sum, n) => sum + review!.changes[n.id].length, 0)
  const current =
    (selected &&
      review?.changes[selected.componentId]?.find((f) => f.path === selected.path) &&
      selected) ||
    (changed[0] && { componentId: changed[0].id, path: review!.changes[changed[0].id][0].path })
  const currentFile = current
    ? (review?.changes[current.componentId]?.find((f) => f.path === current.path) ?? null)
    : null

  return (
    <div className="workspace review-view">
      <Group orientation="horizontal">
        <Panel defaultSize="38" minSize="20">
          <div className="review-list">
            <div className="changes-header">
              <span className="panel-title">
                Review
                {review && (
                  <span className="review-summary">
                    {fileCount} file{fileCount === 1 ? '' : 's'} in {changed.length} component
                    {changed.length === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <button title="Refresh review" onClick={() => setRefresh((n) => n + 1)}>
                ↻ Refresh
              </button>
            </div>
            {error && <div className="hint file-tree-error">{error}</div>}
            {!review && !error && <div className="hint">Loading…</div>}
            {review && !changed.length && <div className="hint">No uncommitted changes.</div>}
            {changed.map((n) => {
              const files = review!.changes[n.id]
              const open = !collapsed[n.id]
              return (
                <section key={n.id} className="review-group">
                  <header className="review-group-header">
                    <button
                      className="review-toggle"
                      aria-expanded={open}
                      aria-label={open ? 'Collapse' : 'Expand'}
                      onClick={() => setCollapsed({ ...collapsed, [n.id]: open })}
                    >
                      {open ? '▾' : '▸'}
                    </button>
                    <span className="kind-dot" style={{ background: KIND_COLOR[n.data.kind] }} />
                    <button className="review-name" onClick={() => select(n.id)}>
                      {n.data.name}
                    </button>
                    <span className="git-badge">±{files.length}</span>
                  </header>
                  <ValidationChips componentId={n.id} changedAt={latestChange(files)} />
                  {open && (
                    <ChangeList
                      files={files}
                      base={n.data.path}
                      selected={current?.componentId === n.id ? current.path : undefined}
                      onSelect={(path) => setSelected({ componentId: n.id, path })}
                    />
                  )}
                </section>
              )
            })}
            {review && review.affected.length > 0 && (
              <>
                <div className="panel-title review-affected-title">May be affected</div>
                {review.affected.map((a) => {
                  const node = nodes.find((n) => n.id === a.id)
                  if (!node) return null
                  return (
                    <section key={a.id} className="review-group affected">
                      <header className="review-group-header">
                        <span
                          className="kind-dot"
                          style={{ background: KIND_COLOR[node.data.kind] }}
                        />
                        <button className="review-name" onClick={() => select(a.id)}>
                          {node.data.name}
                        </button>
                        <span className="review-via">via {a.via.map(nameOf).join(', ')}</span>
                      </header>
                      <ValidationChips
                        componentId={a.id}
                        changedAt={latestChangeOf(review.changes, a.via)}
                      />
                    </section>
                  )
                })}
              </>
            )}
          </div>
        </Panel>
        <Separator className="separator" />
        <Panel defaultSize="62" minSize="30">
          {current ? (
            <DiffView componentId={current.componentId} file={currentFile} revision={revision} />
          ) : (
            <div className="diff-view hint">Nothing to review.</div>
          )}
        </Panel>
      </Group>
    </div>
  )
}
