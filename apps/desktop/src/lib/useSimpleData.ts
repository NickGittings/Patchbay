import { useEffect, useMemo, useState } from 'react'
import { useStore, type FlowNode } from '../store'
import { gitReview, gitWorktrees, mergeOutcome, planRead, proposalRead, onProposal } from './ipc'
import { activeWorktree } from './tasks'
import { relatedSession } from './simple'
import { changeGroups } from './changeGroups'
import { changeRefs } from './changeNav'
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
  /** Retain the last file-list coordinates while the disk reader is paused. */
  nodes: FlowNode[]
  plan: PlanText
  acceptedPlan: PlanText
  proposal: PlannerProposal | null
  review: Review
  worktrees: Worktree[]
  outcome?: MergeOutcome
  /** Why the merge status couldn't be read; the other artifacts still show. */
  outcomeError?: string
}
/** Disk-backed reader. Late replies never cross project/worktree boundaries. */
export function useSimpleData(visible: boolean) {
  const projectId = useStore((s) => s.project?.id)
  const root = useStore((s) => s.project?.root)
  const nodes = useStore((s) => (visible ? s.nodes : undefined))
  const task = useStore((s) => s.activeTask)
  const worktree = useStore(activeWorktree)
  const revision = useStore((s) => s.gitChanges)
  const key = JSON.stringify([projectId, task, worktree])
  const [data, setData] = useState<Artifacts>()
  const [error, setError] = useState<{ key: string; text: string }>()
  useEffect(() => {
    if (!visible || !projectId) return
    let disposed = false,
      pending = false,
      queued = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (disposed) return
      if (pending) {
        queued = true
        return
      }
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void read(), 100)
    }
    const read = async () => {
      if (disposed || pending) return
      pending = true
      const state = useStore.getState()
      const project = state.toProject()
      try {
        const [plan, acceptedPlan, proposal, review, worktrees] = await Promise.all([
          planRead(projectId),
          // The project folder's accepted plan is the project plan itself.
          task ? planRead(projectId, task) : undefined,
          proposalRead(projectId),
          gitReview(project, worktree),
          gitWorktrees(projectId),
        ])
        const merge = latestMerge(state)
        let request: MergeRequest | undefined = merge?.kind === 'action' ? merge.request : undefined
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
        // Recovered requests need the worktree list, so this read follows the others.
        let outcome: MergeOutcome | undefined, outcomeError: string | undefined
        if (request)
          await mergeOutcome(project, request).then(
            (o) => (outcome = o),
            (e) => (outcomeError = String(e)),
          )
        if (!disposed) {
          setData({
            key,
            nodes: state.nodes,
            plan,
            acceptedPlan: acceptedPlan ?? plan,
            proposal,
            review,
            worktrees,
            outcome,
            outcomeError,
          })
          setError(undefined)
        }
      } catch (e) {
        if (!disposed) setError({ key, text: String(e) })
      } finally {
        pending = false
        if (queued) {
          queued = false
          schedule()
        }
      }
    }
    const scope = { projectId, task, path: worktree ?? useStore.getState().project!.root }
    const latestMerge = (state: ReturnType<typeof useStore.getState>) =>
      [...(state.simple?.log ?? [])]
        .reverse()
        .find((e) => e.kind === 'action' && e.action === 'merge' && e.request)
    // Keep one reader for this scope. Change signals share its in-flight guard;
    // an invalidation during a read schedules one follow-up instead of losing the update.
    // Only starts, exits and turn ends can change the artifacts; a turn starting can't.
    const settled = new Set(['idle', 'review', 'ended'])
    const turnEnds = new Map<string, number>()
    const stages = (state: ReturnType<typeof useStore.getState>) =>
      state.sessionRecords
        .filter((r) => relatedSession(r, scope))
        .map((r) => {
          const session = state.sessions[r.id],
            agent = session?.status?.agent
          if (agent && settled.has(agent.state)) turnEnds.set(r.id, agent.sinceMs)
          return `${r.id}:${session?.generation}:${session?.running}:${turnEnds.get(r.id) ?? ''}`
        })
        .join('|')
    let previousStages = stages(useStore.getState())
    const unsubscribe = useStore.subscribe((state, previous) => {
      let changed = state.gitChanges !== previous.gitChanges
      if (state.simple?.log !== previous.simple?.log)
        changed ||= latestMerge(state) !== latestMerge(previous)
      if (
        state.sessions !== previous.sessions ||
        state.sessionRecords !== previous.sessionRecords
      ) {
        const nextStages = stages(state)
        changed ||= previousStages !== nextStages
        previousStages = nextStages
      }
      if (changed) schedule()
    })
    void read()
    const unlisten = onProposal((event) => {
      if (event.projectId === projectId) schedule()
    })
    const focus = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', focus)
    return () => {
      disposed = true
      unsubscribe()
      clearTimeout(refreshTimer)
      void unlisten.then((stop) => stop()).catch(() => {})
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', focus)
    }
  }, [visible, projectId, task, worktree, key])
  const current = data?.key === key ? data : undefined
  const source = current?.worktrees.find((w) => w.path === (worktree ?? root))
  const scope = useMemo(
    () => ({
      projectId: projectId ?? '',
      task,
      path: source?.path ?? worktree ?? root ?? '',
      branch: source?.branch,
    }),
    [projectId, task, source?.path, source?.branch, worktree, root],
  )
  const review = current?.review
  const listedNodes = nodes ?? current?.nodes
  const groups = useMemo(() => changeGroups(listedNodes ?? [], review), [listedNodes, review])
  const files = useMemo(() => changeRefs(groups), [groups])
  const findings = useReviewFindings(projectId, source?.branch ?? undefined, visible, revision)
  return {
    data: current,
    source,
    scope,
    groups,
    files,
    findings,
    error: error?.key === key ? error.text : '',
  }
}
