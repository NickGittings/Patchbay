import RailIcon from './RailIcon'
import { useClockTick } from '../lib/clock'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { useSimpleUi } from '../lib/simpleUi'
import { worktreeAttention } from '../lib/attention'
import { STAGE_LABELS, STATUS_LABELS } from '../lib/autoSettings'
import {
  panelWidth,
  railViews,
  selectedRailView,
  selectPanel,
  selectRailView,
  togglePanel,
  useRail,
  type UtilityPanel,
} from '../lib/rail'
import { isMac, mod } from '../lib/platform'
import { runWorkspaceAction, type WorkspaceAction } from '../lib/workspaceActions'
import ProjectSwitcher from './ProjectSwitcher'
import WorktreePicker from './tasks/WorktreePicker'
import SessionsPanel from './SessionsPanel'
import StackPanel from './StackPanel'
import TaskActivityPanel from './tasks/TaskActivityPanel'
import { useTaskActivities } from '../lib/useTaskActivities'
import AutoPanel from './auto/AutoPanel'
import MapSaveStatus from './MapSaveStatus'
import AttentionMenu from './status/AttentionMenu'
import ExtensionMenu from '../extensions/ExtensionMenu'
import AgentIntegrationsPanel from './AgentIntegrationsPanel'
import AgentRolesPanel from './AgentRolesPanel'
import NotificationsPanel from './NotificationsPanel'
import Menu, { MenuItem } from './Menu'
import PanelContent from './PanelContent'

const utilities: Record<UtilityPanel, { label: string }> = {
  project: { label: 'Project' },
  worktree: { label: 'Worktree' },
  auto: { label: 'Auto mode' },
  activity: { label: 'Activity' },
  stack: { label: 'Stack' },
  sessions: { label: 'Sessions' },
}
function initialWidth() {
  try {
    return Number(localStorage.getItem('patchbay.utilityPanelWidth')) || 360
  } catch {
    return 360
  }
}
export default function WorkspaceRail({ actions }: { actions: WorkspaceAction[] }) {
  useClockTick()
  useTaskActivities()
  const panel = useStore((s) => s.utilityPanel)
  const settings = useRail((s) => s.settings)
  const project = useStore((s) => s.project)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const simple = useStore((s) => s.simpleMode)
  const view = useStore((s) => s.view)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.activeTask))
  const activeTask = useStore((s) => s.activeTask)
  const auto = useStore((s) => s.auto)
  const busy = useStore((s) => s.graphActionBusy)
  const action = useStore((s) => s.graphAction)
  useSimpleUi((s) => s.worktrees)
  const counts = useStore(useShallow(worktreeAttention))
  const count = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const selected = selectedRailView()
  const [sessionsHost, setSessionsHost] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(initialWidth)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const actualWidth = panelWidth(width, windowWidth)
  const worktreeName = task?.title ?? 'Main worktree'
  const panelSubtitle = (id: UtilityPanel) =>
    id === 'project'
      ? (project?.name ?? entry?.name ?? 'No project')
      : id === 'sessions'
        ? 'All projects'
        : `${project?.name ?? 'No project'} · ${worktreeName}`
  const subtitle = panel ? panelSubtitle(panel) : ''
  const closeOnEscape = (e: KeyboardEvent<HTMLElement>) => {
    if (
      e.key === 'Escape' &&
      !e.defaultPrevented &&
      !(e.target as Element).closest('.xterm, input, textarea, select, [role="menu"]')
    ) {
      e.preventDefault()
      selectPanel(null)
    }
  }
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const changeWidth = (value: number) => {
    const next = panelWidth(value, window.innerWidth)
    setWidth(next)
    try {
      localStorage.setItem('patchbay.utilityPanelWidth', String(next))
    } catch {
      /* Storage may be unavailable. */
    }
  }
  const utility = (id: UtilityPanel) => {
    const { label } = utilities[id]
    const status =
      id === 'project' && entry?.mapSave?.status === 'error'
        ? 'Map save failed'
        : id === 'auto' && auto
          ? `${STAGE_LABELS[auto.stage]} · ${STATUS_LABELS[auto.status]}`
          : busy && id === (action?.kind === 'startGroup' ? 'stack' : 'activity')
            ? action?.kind === 'startGroup'
              ? 'Starting stack…'
              : 'Validating…'
            : undefined
    const name = panelSubtitle(id)
    const warning =
      id === 'project' &&
      (entry?.fingerprint === 'absent' ||
        entry?.unavailable ||
        entry?.conflict ||
        ['error', 'conflict'].includes(entry?.mapSave?.status ?? ''))
    return (
      <button
        key={id}
        className={panel === id ? 'active' : ''}
        aria-label={label}
        aria-description={status}
        aria-pressed={panel === id}
        title={`${label}: ${name}${status ? ` · ${status}` : ''}`}
        disabled={!project && id !== 'project' && id !== 'sessions'}
        onClick={() => togglePanel(id)}
      >
        <RailIcon name={id} />
        {status && id !== 'project' && (
          <span
            className="rail-status"
            data-status={id === 'auto' ? auto?.status : 'running'}
            aria-hidden="true"
          />
        )}
        {warning && (
          <sup
            aria-label={status === 'Map save failed' ? status : 'Map needs attention'}
            data-status={status === 'Map save failed' ? 'error' : undefined}
          >
            !
          </sup>
        )}
        {id === 'activity' && count > 0 && (
          <sup aria-label={`${count} need attention`}>{count}</sup>
        )}
      </button>
    )
  }
  return (
    <>
      <nav className="workspace-rail" aria-label="Workspace navigation">
        {utility('project')}
        {utility('worktree')}
        <hr />
        {railViews.map((v, i) => (
          <button
            key={v.id}
            disabled={!project}
            aria-label={v.label}
            aria-pressed={!!project && selected === v.id}
            className={project && selected === v.id ? 'active' : ''}
            title={`${v.label}${simple ? `: ${v.id === 'navigation' ? 'All stages' : v.label}` : ''} (${mod}${i + 1}${simple && i > 0 ? ': return to Full view' : ''})`}
            onClick={() => selectRailView(v.id)}
          >
            <RailIcon name={v.id} />
          </button>
        ))}
        <hr />
        <button
          disabled={!project}
          aria-label="Chat mode"
          aria-pressed={simple}
          className={simple ? 'active' : ''}
          title="Chat mode"
          onClick={() => useStore.getState().setSimpleMode(!simple)}
        >
          <RailIcon name="chat" />
        </button>
        <hr />
        {utility('auto')}
        {utility('activity')}
        {utility('stack')}
        {utility('sessions')}
        <span className="spacer" />
        {!isMac && (
          <Menu
            label={<RailIcon name="settings" />}
            triggerLabel="Settings"
            title="Settings"
            caret={false}
            portal
          >
            {actions
              .filter((a) => a.group === 'settings')
              .map((a) => (
                <MenuItem key={a.id} disabled={!a.enabled} onClick={() => runWorkspaceAction(a)}>
                  {a.title}
                </MenuItem>
              ))}
          </Menu>
        )}
      </nav>
      {panel && (
        <>
          <aside
            className="utility-panel"
            style={{ width: actualWidth }}
            aria-label={`${utilities[panel].label} panel`}
            onKeyDown={closeOnEscape}
          >
            <header className="utility-header">
              <div>
                <h2>{utilities[panel].label}</h2>
                <small title={subtitle}>{subtitle}</small>
              </div>
              <button
                aria-label={`Close ${utilities[panel].label} panel`}
                onClick={() => {
                  selectPanel(null)
                  document
                    .querySelector<HTMLButtonElement>(`[aria-label="${utilities[panel].label}"]`)
                    ?.focus()
                }}
              >
                ×
              </button>
            </header>
            <div
              className="utility-scroll"
              ref={panel === 'sessions' ? setSessionsHost : undefined}
            >
              <PanelContent>
                {panel === 'project' && (
                  <>
                    <ProjectSwitcher />
                    <hr />
                    <MapSaveStatus />
                    <div className="project-actions">
                      {actions
                        .filter((a) => a.group === 'project' && a.id !== 'save')
                        .map((a) => (
                          <button
                            key={a.id}
                            disabled={!a.enabled}
                            onClick={() => runWorkspaceAction(a)}
                          >
                            {a.title}
                          </button>
                        ))}
                      <ExtensionMenu slot="toolbar" />
                    </div>
                  </>
                )}
                {panel === 'worktree' && project && (
                  <WorktreePicker key={project.id} copyPlan={!simple && view === 'plan'} />
                )}
                {panel === 'auto' && project && (
                  <AutoPanel
                    key={JSON.stringify([project.id, activeTask])}
                    simple={simple}
                    onIntegrations={() => useRail.setState({ settings: 'integrations' })}
                  />
                )}
                {panel === 'activity' && project && (
                  <>
                    <AttentionMenu />
                    <TaskActivityPanel />
                  </>
                )}
                {panel === 'stack' && project && <StackPanel key={project.id} />}
                {!project && !['project', 'sessions'].includes(panel) && (
                  <p>Open a project to use {utilities[panel].label}.</p>
                )}
              </PanelContent>
            </div>
          </aside>
          <div
            className="utility-resize"
            role="separator"
            aria-label="Resize utility panel"
            aria-orientation="vertical"
            aria-valuemin={240}
            aria-valuemax={panelWidth(640, windowWidth)}
            aria-valuenow={actualWidth}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                changeWidth(actualWidth + (e.key === 'ArrowLeft' ? -20 : 20))
              }
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) changeWidth(e.clientX - 52)
            }}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
          />
        </>
      )}
      <SessionsPanel host={sessionsHost} onKeyDown={closeOnEscape} />
      {settings === 'integrations' && (
        <AgentIntegrationsPanel onClose={() => useRail.setState({ settings: null })} />
      )}
      {settings === 'roles' && project && (
        <AgentRolesPanel onClose={() => useRail.setState({ settings: null })} />
      )}
      {settings === 'notifications' && (
        <NotificationsPanel onClose={() => useRail.setState({ settings: null })} />
      )}
    </>
  )
}
