import RailIcon from './RailIcon'
import RailTooltip from './RailTooltip'
import UsagePanel from './UsagePanel'
import { useUsage, usageWarnings } from '../lib/usage'
import { useClockTick } from '../lib/clock'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { worktreeAttention } from '../lib/attention'
import { STAGE_LABELS, STATUS_LABELS } from '../lib/autoSettings'
import {
  panelWidth,
  railWidth,
  setRailExpanded,
  railViews,
  selectedRailView,
  selectPanel,
  selectRailView,
  togglePanel,
  useRail,
  type UtilityPanel,
} from '../lib/rail'
import { mod } from '../lib/platform'
import SessionsPanel from './SessionsPanel'
import StackPanel from './StackPanel'
import TaskActivityPanel from './tasks/TaskActivityPanel'
import { useTaskActivities } from '../lib/useTaskActivities'
import AutoPanel from './auto/AutoPanel'
import AttentionMenu from './status/AttentionMenu'
import AgentIntegrationsPanel from './AgentIntegrationsPanel'
import { integrationsProvider, integrationsSetting } from '../lib/agentHooks'
import AgentProfilesPanel from './AgentProfilesPanel'
import AgentRolesPanel from './AgentRolesPanel'
import NotificationsPanel from './NotificationsPanel'
import PanelContent from './PanelContent'

const utilities: Record<UtilityPanel, { label: string }> = {
  project: { label: 'Project' },
  worktree: { label: 'Worktree' },
  auto: { label: 'Auto mode' },
  activity: { label: 'Activity' },
  stack: { label: 'Stack' },
  sessions: { label: 'Sessions' },
  usage: { label: 'Usage' },
}
const WIDTH_KEY = 'patchbay.utilityPanelWidth'

function initialWidth() {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || 360
  } catch {
    return 360
  }
}
function focusPanelTrigger(panel: UtilityPanel) {
  const host =
    panel === 'project' || panel === 'worktree' ? '.workspace-context' : '.workspace-rail'
  const trigger = document.querySelector<HTMLButtonElement>(
    `${host} [aria-label="${utilities[panel].label}"]`,
  )
  if (trigger?.getClientRects().length) trigger.focus()
  else
    document.querySelector<HTMLButtonElement>('.workspace-context [aria-label="Worktree"]')?.focus()
}
export default function WorkspaceRail() {
  useClockTick()
  const usage = useUsage((s) => s.usage)
  const usageSettings = useStore((s) => s.usageSettings)
  // Relative usage windows advance with the shared clock tick.
  // oxlint-disable-next-line react/purity
  const usageWarning = usageWarnings(usage, usageSettings, Date.now()).length > 0
  useTaskActivities()
  const panel = useStore((s) => s.utilityPanel)
  const settings = useRail((s) => s.settings)
  const project = useStore((s) => s.project)
  const entry = useStore((s) => s.projects[s.activeProjectId ?? ''])
  const simple = useStore((s) => s.simpleMode)
  const task = useStore((s) => s.tasks.find((t) => t.id === s.activeTask))
  const activeTask = useStore((s) => s.activeTask)
  const auto = useStore((s) => s.auto)
  const busy = useStore((s) => s.graphActionBusy)
  const action = useStore((s) => s.graphAction)
  const counts = useStore(useShallow(worktreeAttention))
  const count = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const selected = selectedRailView()
  const [sessionsActions, setSessionsActions] = useState<HTMLDivElement | null>(null)
  const [sessionsHost, setSessionsHost] = useState<HTMLDivElement | null>(null)
  const [resizing, setResizing] = useState(false)
  const [width, setWidth] = useState(initialWidth)
  const [windowWidth, setWindowWidth] = useState(window.innerWidth)
  const expanded = useRail((s) => s.expanded)
  const navigationWidth = railWidth(expanded, windowWidth)
  const labeled = navigationWidth > 52
  const actualWidth = panelWidth(width, windowWidth, navigationWidth)
  const worktreeName = task?.title ?? 'Main worktree'
  const panelSubtitle = (id: UtilityPanel) =>
    id === 'project'
      ? (project?.name ?? entry?.name ?? 'No project')
      : id === 'sessions' || id === 'usage'
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
      if (panel) focusPanelTrigger(panel)
    }
  }
  useEffect(() => {
    const resize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const saveWidth = (next: number) => {
    try {
      localStorage.setItem(WIDTH_KEY, String(next))
    } catch {
      /* Storage may be unavailable. */
    }
  }
  const changeWidth = (value: number, save = true) => {
    const next = panelWidth(value, window.innerWidth, navigationWidth)
    setWidth(next)
    if (save) saveWidth(next)
    return next
  }
  // A drag keeps the edge where it was grabbed and saves the width once, when it ends.
  const drag = useRef<{ offset: number; width?: number }>(undefined)
  const railRight = () =>
    document.querySelector('.workspace-rail')?.getBoundingClientRect().right ?? navigationWidth
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
      <RailTooltip
        key={id}
        className={panel === id ? 'utility-active' : ''}
        aria-label={label}
        aria-description={status}
        aria-pressed={panel === id}
        tooltip={`${label}: ${name}${status ? ` · ${status}` : ''}${id === 'activity' && count ? ` · ${count} need attention` : ''}${id === 'usage' && usageWarning ? ' · Usage limit warning' : ''}`}
        disabled={!project && id !== 'project' && id !== 'sessions' && id !== 'usage'}
        onClick={() => togglePanel(id)}
      >
        <RailIcon name={id} />
        <span className="rail-label">{label}</span>
        {id === 'usage' && usageWarning && (
          <span className="rail-status usage-dot" aria-label="Usage limit warning" />
        )}
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
      </RailTooltip>
    )
  }
  return (
    <>
      <nav className="workspace-rail" data-expanded={labeled} aria-label="Workspace navigation">
        <span className="rail-group-label">Views</span>
        {railViews.map((v, i) => (
          <RailTooltip
            key={v.id}
            disabled={!project}
            aria-label={v.label}
            aria-pressed={!!project && selected === v.id}
            className={project && selected === v.id ? 'view-active' : ''}
            tooltip={`${v.label}${simple ? ': open Full view' : ''}`}
            shortcut={`${mod}${i + 1}`}
            onClick={() => selectRailView(v.id)}
          >
            <RailIcon name={v.id} />
            <span className="rail-label">{v.label}</span>
          </RailTooltip>
        ))}
        <hr />
        <span className="rail-group-label">Mode</span>
        <RailTooltip
          disabled={!project}
          aria-label="Chat mode"
          aria-pressed={simple}
          className={simple ? 'toggle-active' : ''}
          tooltip="Chat mode"
          onClick={() => useStore.getState().setSimpleMode(!simple)}
        >
          <RailIcon name="chat" />
          <span className="rail-label">Chat mode</span>
        </RailTooltip>
        <hr />
        <span className="rail-group-label">Tools</span>
        {utility('auto')}
        {utility('activity')}
        {utility('stack')}
        {utility('sessions')}
        {utility('usage')}
        <span className="spacer" />
        <RailTooltip
          aria-label={expanded ? 'Collapse navigation labels' : 'Expand navigation labels'}
          aria-expanded={labeled}
          tooltip={
            windowWidth < 1100
              ? 'Navigation labels appear in wider windows'
              : 'Toggle navigation labels'
          }
          disabled={windowWidth < 1100}
          onClick={() => setRailExpanded(!expanded)}
        >
          <span aria-hidden="true">{labeled ? '«' : '»'}</span>
          <span className="rail-label">Collapse</span>
        </RailTooltip>
      </nav>
      {panel && panel !== 'project' && panel !== 'worktree' && (
        <>
          <aside
            className="utility-panel"
            data-panel={panel}
            style={{ width: actualWidth }}
            aria-label={`${utilities[panel].label} panel`}
            onKeyDown={closeOnEscape}
          >
            <header className="utility-header">
              <div>
                <h2>{utilities[panel].label}</h2>
                <small title={subtitle}>{subtitle}</small>
              </div>
              {panel === 'sessions' && (
                <div className="panel-section-head" ref={setSessionsActions} />
              )}
              <button
                aria-label={`Close ${utilities[panel].label} panel`}
                title="Close panel"
                onClick={() => {
                  selectPanel(null)
                  focusPanelTrigger(panel)
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
                {panel === 'auto' && project && (
                  <AutoPanel
                    key={JSON.stringify([project.id, activeTask])}
                    simple={simple}
                    onIntegrations={(provider) =>
                      useRail.setState({ settings: integrationsSetting(provider) })
                    }
                  />
                )}
                {panel === 'activity' && project && (
                  <>
                    <AttentionMenu />
                    <TaskActivityPanel />
                  </>
                )}
                {panel === 'stack' && project && <StackPanel key={project.id} />}
                {panel === 'usage' && <UsagePanel />}
                {!project && !['project', 'sessions', 'usage'].includes(panel) && (
                  <p>Open a project to use {utilities[panel].label}.</p>
                )}
              </PanelContent>
            </div>
          </aside>
          <div
            className="utility-resize"
            data-resizing={resizing || undefined}
            role="separator"
            aria-label="Resize utility panel"
            aria-orientation="vertical"
            aria-valuemin={240}
            aria-valuemax={panelWidth(640, windowWidth, navigationWidth)}
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
              drag.current = { offset: e.clientX - (railRight() + actualWidth) }
              setResizing(true)
            }}
            onPointerMove={(e) => {
              if (drag.current && e.currentTarget.hasPointerCapture(e.pointerId))
                drag.current.width = changeWidth(
                  e.clientX - drag.current.offset - railRight(),
                  false,
                )
            }}
            onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
            onLostPointerCapture={() => {
              if (drag.current?.width !== undefined) saveWidth(drag.current.width)
              drag.current = undefined
              setResizing(false)
            }}
          />
        </>
      )}
      <SessionsPanel headerHost={sessionsActions} host={sessionsHost} onKeyDown={closeOnEscape} />
      {integrationsProvider(settings) !== undefined && (
        <AgentIntegrationsPanel
          key={settings}
          initialProvider={integrationsProvider(settings) ?? undefined}
          onClose={() => useRail.setState({ settings: null })}
        />
      )}
      {settings === 'profiles' && (
        <AgentProfilesPanel onClose={() => useRail.setState({ settings: null })} />
      )}
      {settings === 'roles' && (
        <AgentRolesPanel onClose={() => useRail.setState({ settings: null })} />
      )}
      {settings === 'notifications' && (
        <NotificationsPanel onClose={() => useRail.setState({ settings: null })} />
      )}
    </>
  )
}
