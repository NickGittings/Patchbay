import { useEffect, useMemo, useState } from 'react'
import { useStore, type FlowNode } from '../store'
import {
  gitReview,
  gitBranches,
  gitWorktrees,
  mergeOutcome,
  planRead,
  proposalRead,
  onProposal,
} from './ipc'
import { chatReviewBase } from './reviewAgents'
import { activeWorktree } from './tasks'
import { relatedSession, workflowLog } from './simple'
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
  selectionKey: string
  /** Retain the last file-list coordinates while the disk reader is paused. */
  nodes: FlowNode[]
  plan: PlanText
  acceptedPlan: PlanText
  proposal: PlannerProposal | null
  /** Absent when the reader skipped the diff. */
  review?: Review
  base?: string
  worktrees: Worktree[]
  branches: string[]
  outcome?: MergeOutcome
  /** Why the merge status couldn't be read; the other artifacts still show. */
  outcomeError?: string
}
/** Disk-backed reader. Late replies never cross project/worktree boundaries. */
/**
 * `diff` reads the worktree's changes too, which only Chat's Changes need; the Plan and Review
 * views and the Auto panel read just the stage artifacts.
 */
export function useSimpleData(visible: boolean, diff = true) {
  const projectId = useStore((s) => s.project?.id)
  const root = useStore((s) => s.project?.root)
  const nodes = useStore((s) => (visible ? s.nodes : undefined))
  const task = useStore((s) => s.activeTask)
  const worktree = useStore(activeWorktree)
  const revision = useStore((s) => s.gitChanges)
  const selectionKey = JSON.stringify([projectId, task, worktree])
  const [retryVersion, setRetryVersion] = useState(0)
  const [data, setData] = useState<Artifacts>()
  const sourceData = data?.selectionKey === selectionKey ? data : undefined
  const source = sourceData?.worktrees.find((w) => (worktree ? w.path === worktree : w.current))
  const findings = useReviewFindings(projectId, source?.branch, visible, revision)
  const savedBase = findings?.findings?.base
  const key = JSON.stringify([selectionKey, savedBase])
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
        const scopedPlan = await planRead(projectId, task ?? undefined)
        const worktreeRead = gitWorktrees(projectId)
        const [plan, acceptedPlan, proposal, worktrees, branches] = await Promise.all([
          scopedPlan,
          // The project folder's accepted plan is the project plan itself.
          scopedPlan,
          proposalRead(projectId, task ?? undefined),
          worktreeRead,
          worktreeRead.then((trees) => (trees.length ? gitBranches(projectId) : [])),
        ])
        // Resolve the comparison from fresh metadata on every read, so an old
        // saved base cannot prevent these artifacts from refreshing.
        const source = worktrees.find((w) => (worktree ? w.path === worktree : w.current))
        const base = chatReviewBase(source, state.tasks, worktrees, branches, savedBase)
        const review = diff ? await gitReview(project, worktree, base) : undefined
        const merge = latestMerge(state)
        const request: MergeRequest | undefined =
          merge?.kind === 'action' ? merge.request : undefined
        // Legacy records retain paths but not the original branch pair. Current checkouts
        // cannot establish what was merged after branches switch or cleanup removes a tree.
        const recovered =
          !request &&
          state.sessionRecords.some(
            (r) =>
              r.metadata.projectId === projectId &&
              r.metadata.componentId === '@merge' &&
              r.spec.merge_source === (worktree ?? project.root),
          )
        let outcome: MergeOutcome | undefined
        let outcomeError: string | undefined = recovered
          ? 'The original merge request is unavailable.'
          : undefined
        if (request)
          await mergeOutcome(project, request).then(
            (o) => (outcome = o),
            (e) => (outcomeError = String(e)),
          )
        if (!disposed) {
          setData({
            key,
            selectionKey,
            nodes: state.nodes,
            plan,
            acceptedPlan: acceptedPlan ?? plan,
            proposal,
            review,
            worktrees,
            branches,
            base,
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
      [...workflowLog(state.simple)]
        .reverse()
        .find((e) => e.kind === 'action' && e.action === 'merge' && e.request)
    // Keep one reader for this scope. Change signals share its in-flight guard;
    // an invalidation during a read schedules one follow-up instead of losing the update.
    // Only starts, exits and turn ends can change the artifacts; a turn starting can't.
    const settled = new Set(['idle', 'review', 'ended'])
    const turnEnds = new Map<string, number>()
    const stages = (state: ReturnType<typeof useStore.getState>) =>
      state.sessionRecords
        .filter((r) =>
          relatedSession(r, scope, (state.sessions[r.id] ?? r.snapshot)?.generation, state.simple),
        )
        .map((r) => {
          const session = state.sessions[r.id],
            agent = session?.status?.agent
          if (agent && settled.has(agent.state)) turnEnds.set(r.id, agent.sinceMs)
          return `${r.id}:${session?.generation}:${session?.running}:${turnEnds.get(r.id) ?? ''}`
        })
        .join('|')
    let previousStages = stages(useStore.getState())
    const unsubscribe = useStore.subscribe((state, previous) => {
      let changed = state.gitChanges !== previous.gitChanges || state.tasks !== previous.tasks
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
  }, [visible, diff, projectId, task, worktree, key, savedBase, selectionKey, retryVersion])
  const current = data?.key === key && error?.key !== key ? data : undefined
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
  return {
    retry: () => setRetryVersion(retryVersion + 1),
    data: current,
    // Branch metadata remains usable while artifacts reload for a newly saved review base.
    worktrees: sourceData?.worktrees ?? [],
    branches: sourceData?.branches ?? [],
    base: current?.base,
    source,
    scope,
    groups,
    files,
    findings,
    error: error?.key === key ? error.text : '',
  }
}
