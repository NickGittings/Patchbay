import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { REVIEW_SCOPE, type ReviewFindings } from '../types'
import { reviewRead } from './ipc'

/** Keep findings current on polling, focus and review exits, discarding results for old branches. */
export function useReviewFindings(projectId: string | undefined, branch: string | undefined) {
  const exits = useStore((s) =>
    s.sessionRecords
      .filter((r) => r.metadata.projectId === projectId && r.metadata.componentId === REVIEW_SCOPE)
      .map((r) => `${r.id}:${s.sessions[r.id]?.running}:${s.sessions[r.id]?.exitedMs}`)
      .join(','),
  )
  const key = JSON.stringify([projectId, branch])
  const [loaded, setLoaded] = useState<{
    key: string
    findings: ReviewFindings | null
    error?: string
  }>()
  useEffect(() => {
    if (!projectId || !branch) return
    let disposed = false
    let pending = false
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const findings = await reviewRead(projectId, branch)
        if (!disposed) setLoaded({ key, findings })
      } catch (e) {
        if (!disposed) setLoaded({ key, findings: null, error: String(e) })
      } finally {
        pending = false
      }
    }
    void read()
    const poll = window.setInterval(() => void read(), 5000)
    const focus = () => void read()
    window.addEventListener('focus', focus)
    return () => {
      disposed = true
      window.clearInterval(poll)
      window.removeEventListener('focus', focus)
    }
  }, [projectId, branch, key, exits])
  return loaded?.key === key ? loaded : undefined
}
