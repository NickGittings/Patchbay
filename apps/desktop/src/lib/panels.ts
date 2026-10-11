import { useMemo } from 'react'
import { useStore } from '../store'
import { MERGE_SCOPE, PLAN_SCOPE, sessionId, sessionMetadata, type TerminalSpec } from '../types'

type State = ReturnType<typeof useStore.getState>

/**
 * Navigation shows the Inspector while an existing component or link is selected, unless the user
 * closed it, or with nothing selected once the user opened it (`inspector`: `null` follows the
 * selection).
 */
export const showsInspector = (
  s: Pick<State, 'inspector' | 'selectedId' | 'selectedEdgeId' | 'nodes' | 'edges'>,
) =>
  s.inspector ??
  ((!!s.selectedId && s.nodes.some((n) => n.id === s.selectedId)) ||
    (!!s.selectedEdgeId && s.edges.some((e) => e.id === s.selectedEdgeId)))

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
  'nodes' | 'selectedId' | 'sessions' | 'runtimeTerminals' | 'activeTask' | 'dockKept' | 'project'
>

const listed = (s: DockState, sid: string) =>
  !!s.sessions[sid]?.running || (s.dockKept.includes(sid) && !!s.sessions[sid])

/**
 * The Navigation dock's tabs: running sessions of the selected component, or of the whole project
 * when nothing is selected or the selected component has none. Exited sessions stay listed while
 * kept (`dockKept`), so a failure's output doesn't vanish; with no tabs the dock is hidden.
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
      .filter(
        ([, t]) =>
          t.componentId !== MERGE_SCOPE &&
          t.componentId !== PLAN_SCOPE &&
          t.projectId === s.project?.id &&
          (t.taskId ?? null) === task,
      )
      .filter(([sid]) => !all.some((t) => t.sid === sid))
      .map(([sid, t]) => ({
        sid,
        componentId: t.componentId,
        component: '',
        terminal: t.terminal,
        task: t.taskId ?? null,
      })),
  )
  const shown = all.filter((t) => listed(s, t.sid))
  const own = shown.filter((t) => t.componentId === s.selectedId)
  const tabs = own.length ? own : shown
  return tabs.map(({ component, ...t }) => ({
    ...t,
    label: own.length || !component ? t.terminal.name : `${component} · ${t.terminal.name}`,
  }))
}

/**
 * Whether the Navigation dock has tabs, as `dockTabs` would list them, looking only at the running
 * and kept sessions: a selector run on every store change.
 */
export function hasDockTabs(s: DockState): boolean {
  const inDock = (sid: string) => {
    if (!listed(s, sid)) return false
    const runtime = s.runtimeTerminals[sid]
    const meta = sessionMetadata.get(sid)
    if (
      meta &&
      sessionId(meta.componentId, meta.terminalId, s.activeTask) === sid &&
      s.nodes.some(
        (n) => n.id === meta.componentId && n.data.terminals.some((t) => t.id === meta.terminalId),
      )
    )
      return true
    return (
      !!runtime &&
      runtime.componentId !== MERGE_SCOPE &&
      runtime.componentId !== PLAN_SCOPE &&
      runtime.projectId === s.project?.id &&
      (runtime.taskId ?? null) === s.activeTask
    )
  }
  return Object.keys(s.sessions).some(inDock)
}

export function useDockTabs(): DockTab[] {
  const nodes = useStore((s) => s.nodes)
  const selectedId = useStore((s) => s.selectedId)
  const sessions = useStore((s) => s.sessions)
  const runtimeTerminals = useStore((s) => s.runtimeTerminals)
  const activeTask = useStore((s) => s.activeTask)
  const dockKept = useStore((s) => s.dockKept)
  const project = useStore((s) => s.project)
  return useMemo(
    () =>
      dockTabs({ nodes, selectedId, sessions, runtimeTerminals, activeTask, dockKept, project }),
    [nodes, selectedId, sessions, runtimeTerminals, activeTask, dockKept, project],
  )
}
