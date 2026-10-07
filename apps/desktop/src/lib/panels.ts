import { useMemo } from 'react'
import { useStore } from '../store'
import { sessionId, type TerminalSpec } from '../types'

type State = ReturnType<typeof useStore.getState>

/**
 * Navigation shows the Inspector while something is selected, unless the user closed it, or with
 * nothing selected once the user opened it (`inspector`: `null` follows the selection).
 */
export const showsInspector = (s: Pick<State, 'inspector' | 'selectedId' | 'selectedEdgeId'>) =>
  s.inspector ?? (!!s.selectedId || !!s.selectedEdgeId)

/** Hide the Inspector, keeping the selection; selecting something else shows it again. */
export const closeInspector = () => useStore.setState({ inspector: false })

export interface DockTab {
  sid: string
  componentId: string
  terminal: TerminalSpec
  label: string
  /** `null` for the open worktree. */
  task: string | null
}

type DockState = Pick<
  State,
  | 'nodes'
  | 'selectedId'
  | 'sessions'
  | 'runtimeTerminals'
  | 'activeTask'
  | 'dockSession'
  | 'project'
>

/**
 * The Navigation dock's tabs: running sessions of the selected component, or of the whole project
 * when nothing is selected or the selected component has none. The session the dock showed stays
 * listed after it exits (`dockSession`), so a failure's output doesn't vanish; with no tabs the
 * dock is hidden.
 */
export function dockTabs(s: DockState): DockTab[] {
  const task = s.activeTask
  const all = s.nodes.flatMap((n) =>
    n.data.terminals.map((t) => ({
      sid: sessionId(n.id, t.id, task),
      componentId: n.id,
      component: n.data.name,
      terminal: t,
      task,
    })),
  )
  all.push(
    ...Object.entries(s.runtimeTerminals)
      .filter(([, t]) => t.projectId === s.project?.id && (t.taskId ?? null) === task)
      .filter(([sid]) => !all.some((t) => t.sid === sid))
      .map(([sid, t]) => ({
        sid,
        componentId: t.componentId,
        component: '',
        terminal: t.terminal,
        task: t.taskId ?? null,
      })),
  )
  const shown = all.filter(
    (t) => s.sessions[t.sid]?.running || (t.sid === s.dockSession && !!s.sessions[t.sid]),
  )
  const own = shown.filter((t) => t.componentId === s.selectedId)
  const tabs = own.length ? own : shown
  return tabs.map(({ component, ...t }) => ({
    ...t,
    label: own.length || !component ? t.terminal.name : `${component} · ${t.terminal.name}`,
  }))
}

/** Whether the Navigation dock has terminal tabs; a narrow selector for layout. */
export const hasDockTabs = (s: DockState) => dockTabs(s).length > 0

export function useDockTabs(): DockTab[] {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const activeTask = useStore((s) => s.activeTask)
  const dockSession = useStore((s) => s.dockSession)
  const project = useStore((s) => s.project)
  return useMemo(
    () =>
      dockTabs({
        nodes,
        selectedId,
        sessions,
        runtimeTerminals,
        activeTask,
        dockSession,
        project,
      }),
    [nodes, selectedId, sessions, runtimeTerminals, activeTask, dockSession, project],
  )
}
