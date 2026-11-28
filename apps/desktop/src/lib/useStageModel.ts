import { createContext, useContext, useMemo } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { focusTeam, LEAD_HOME_TASK, useChatTeams } from './chatTeams'
import { useExpiredDeadline } from './clock'
import { chatReviewBase } from './reviewAgents'
import { LAUNCH_RECORD_GRACE_MS, pendingLaunch, recordStage, thread } from './simple'
import { EMPTY_SIMPLE_UI, simpleKey, useSimpleUi } from './simpleUi'
import { stageModel } from './stageModel'
import type { useSimpleData } from './useSimpleData'

export type WorktreeReader = ReturnType<typeof useSimpleData>
/** The active worktree's artifacts, read once for Chat, the Auto panel and Plan and Review. */
export const WorktreeReaderContext = createContext<WorktreeReader | null>(null)
/** Whether an open Chat (or its Changes or Agents pane) needs the reader. */
export const useChatReading = create<{ reading: boolean }>(() => ({ reading: false }))

/**
 * The active worktree's stage model, from the shared reader. Chat, the Auto panel and the Plan
 * and Review views all show this, so a stage started in any of them reads the same everywhere.
 * Null where no reader is mounted.
 */
export function useStageModel(explicit?: WorktreeReader) {
  const context = useContext(WorktreeReaderContext)
  const reader = explicit ?? context
  const s = useStore(
    useShallow((s) => ({
      project: s.project,
      activeTask: s.activeTask,
      tasks: s.tasks,
      sessionRecords: s.sessionRecords,
      sessions: s.sessions,
      simple: s.simple,
      auto: s.auto,
    })),
  )
  const key = simpleKey(s.project?.id, s.activeTask)
  const lead = useChatTeams((state) =>
    state.teams[s.project?.id ?? '']?.find((t) => t.task === LEAD_HOME_TASK),
  )
  const team = useMemo(() => focusTeam(lead, s.activeTask), [lead, s.activeTask])
  const ui = useSimpleUi((u) => u.worktrees[key] ?? EMPTY_SIMPLE_UI)
  const data = reader?.data
  const snapshot = {
    records: s.sessionRecords,
    sessions: s.sessions,
    simple: s.simple,
    auto: s.auto,
    ...data,
    findings: reader?.findings?.findings,
    createdMs: s.tasks.find((t) => t.id === s.activeTask)?.createdMs,
    lead: team?.lead.sessionId,
  }
  const worktree = reader?.scope ?? {
    projectId: s.project?.id ?? '',
    task: s.activeTask,
    path: s.project?.root ?? '',
  }
  const model = thread(snapshot, worktree)
  const launch = pendingLaunch(snapshot, model.records)
  const now = useExpiredDeadline(launch ? launch.atMs + LAUNCH_RECORD_GRACE_MS : undefined)
  if (!reader) return null
  const { source, worktrees, branches, error } = reader
  const merging = model.records.filter((r) => recordStage(r) === 'merge').at(-1)
  const mergeBase =
    model.stage === 'merge'
      ? worktrees.find((w) => w.path === merging?.spec.cwd)?.branch
      : undefined
  const base = chatReviewBase(source, s.tasks, worktrees, branches, mergeBase)
  const flowSnapshot = {
    ...snapshot,
    worktree,
    outcomePending: !data && !error,
    outcomeError: data?.outcomeError || error || undefined,
    base: base ?? undefined,
    now,
  }
  return {
    key,
    team,
    ui,
    launch,
    now,
    ...stageModel({ snapshot: flowSnapshot, model, team }),
  }
}
