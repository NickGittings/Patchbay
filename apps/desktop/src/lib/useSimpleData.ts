import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { gitReview, gitWorktrees, mergeOutcome, planRead, proposalRead, onProposal } from './ipc'
import { activeWorktree } from './tasks'
import { useReviewFindings } from './useReviewFindings'
import type {
  MergeOutcome,
  MergeRequest,
  PlanText,
  PlannerProposal,
  Review,
  Worktree,
} from '../types'

interface Artifacts {
  key: string
  plan: PlanText
  acceptedPlan: PlanText
  proposal: PlannerProposal | null
  review: Review
  worktrees: Worktree[]
  outcome?: MergeOutcome
}
/** Disk-backed reader. Late replies never cross project/worktree boundaries. */
export function useSimpleData(visible: boolean) {
  const projectId = useStore((s) => s.project?.id)
  const task = useStore((s) => s.activeTask)
  const worktree = useStore(activeWorktree)
  const revision = useStore((s) => s.gitChanges)
  const log = useStore((s) => s.simple?.log)
  const stages = useStore((s) =>
    s.sessionRecords
      .filter((r) => r.metadata.projectId === projectId)
      .map((r) => `${r.id}:${s.sessions[r.id]?.running}:${s.sessions[r.id]?.status?.agent?.state}`)
      .join('|'),
  )
  const key = JSON.stringify([projectId, task, worktree])
  const [data, setData] = useState<Artifacts>()
  const [error, setError] = useState<{ key: string; text: string }>()
  useEffect(() => {
    if (!visible || !projectId) return
    let disposed = false,
      pending = false
    const project = useStore.getState().toProject()
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const [plan, acceptedPlan, proposal, review, worktrees] = await Promise.all([
          planRead(projectId),
          planRead(projectId, task ?? undefined),
          proposalRead(projectId),
          gitReview(project, worktree),
          gitWorktrees(projectId),
        ])
        const state = useStore.getState()
        const latestMerge = [...(log ?? [])]
          .reverse()
          .find((e) => e.kind === 'action' && e.action === 'merge' && e.request)
        let request: MergeRequest | undefined =
          latestMerge?.kind === 'action' ? latestMerge.request : undefined
        // Recovered merge records explicitly retain source and destination paths.
        if (!request) {
          const source = worktree ?? project.root
          const record = [...state.sessionRecords]
            .reverse()
            .find(
              (r) =>
                r.metadata.projectId === projectId &&
                r.metadata.componentId === '@merge' &&
                r.spec.merge_source === source,
            )
          const from = worktrees.find((w) => w.path === source),
            to = worktrees.find((w) => w.path === record?.spec.cwd)
          if (record && from?.branch && to?.branch)
            request = {
              source,
              sourceBranch: from.branch,
              destination: to.path,
              destinationBranch: to.branch,
            }
        }
        const outcome = request ? await mergeOutcome(project, request) : undefined
        if (!disposed) {
          setData({ key, plan, acceptedPlan, proposal, review, worktrees, outcome })
          setError(undefined)
        }
      } catch (e) {
        if (!disposed) setError({ key, text: String(e) })
      } finally {
        pending = false
      }
    }
    void read()
    const unlisten = onProposal((event) => {
      if (event.projectId === projectId) void read()
    })
    const timer = window.setInterval(() => void read(), 5000)
    const focus = () => void read()
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      disposed = true
      void unlisten.then((stop) => stop()).catch(() => {})
      clearInterval(timer)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [visible, projectId, task, worktree, revision, key, stages, log])
  const current = data?.key === key ? data : undefined
  const source = current?.worktrees.find(
    (w) => w.path === (worktree ?? useStore.getState().project?.root),
  )
  const findings = useReviewFindings(projectId, source?.branch ?? undefined, visible, revision)
  return { data: current, source, findings, error: error?.key === key ? error.text : '' }
}
