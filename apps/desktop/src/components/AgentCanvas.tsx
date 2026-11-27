import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type FitViewOptions,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useStore } from '../store'
import type { SessionRecord, SessionState } from '../types'
import { activityLabel, turnSteps } from '../lib/activity'
import {
  AGENT_CANVAS_INSET,
  AGENT_CARD_HEIGHT,
  AGENT_CARD_WIDTH,
  agentColumns,
  agentDismissible,
  agentLayout,
  agentSnippet,
  type AgentCard,
} from '../lib/chatAgents'
import { failedJob, workerCounts, workerStatus } from '../lib/chatProgress'
import { RESTART_NOTICE, type ChatTeam } from '../lib/chatTeams'
import type { Health } from '../lib/display'
import type { ProviderJob } from '../lib/orchestration'
import { useChatAgents } from '../lib/useChatAgents'
import { useReducedMotion } from '../lib/useReducedMotion'
import { CANVAS_GESTURES } from '../lib/canvasGestures'
import { DETAILS_TRANSITIONING, transitionPanels } from '../lib/panelTransition'
import { useTeamAction, type TeamWork } from '../lib/useTeamWork'
import {
  AssignmentReport,
  Instructions,
  RetryOnAgent,
  showSessions,
  showSettings,
} from './ChatCoordination'
import CanvasMinimap, { MinimapToggle } from './CanvasMinimap'
import EmptyState from './EmptyState'
import Markdown from './findings/Markdown'
import SimpleStatus from './SimpleStatus'
import { SimpleWorktreeContext } from './stories/simpleChanges'
import { StoryViewTabs } from './stories/StoryBoard'

type AgentNodeData = { card: AgentCard } & Record<string, unknown>
type AgentFlowNode = Node<AgentNodeData, 'agent'>

const AgentActions = createContext<{
  select: (id: string) => void
  openTerminal: (card: AgentCard) => void
  dismiss: (job: ProviderJob) => void
}>({ select: () => {}, openTerminal: () => {}, dismiss: () => {} })

const nameOf = ({ role, detail }: AgentCard) => (detail ? `${role} ${detail}` : role)

/** Keeps cards clear of the tabs and team status that float over the canvas's top edge. */
const FIT_VIEW: FitViewOptions = {
  padding: {
    top: `${AGENT_CANVAS_INSET.top}px`,
    right: `${AGENT_CANVAS_INSET.side}px`,
    bottom: `${AGENT_CANVAS_INSET.bottom}px`,
    left: `${AGENT_CANVAS_INSET.side}px`,
  },
  maxZoom: 1,
}
/** Matches `.agent-details`: its width and its inset from the canvas edge. */
const DETAILS_WIDTH = 360
const DETAILS_INSET = 12

const JOB_HEALTH: Record<string, Health> = {
  'awaiting input': 'input',
  failed: 'fail',
  complete: 'ok',
  working: 'working',
}

function minimapColor(node: Node) {
  const { roleKey, row } = (node as AgentFlowNode).data.card
  const color = `var(--role-${roleKey})`
  return row === 'finished' ? `color-mix(in srgb, ${color} 45%, transparent)` : color
}

function AgentStatus({ card, session }: { card: AgentCard; session: SessionState | undefined }) {
  if (!card.job) return <SimpleStatus sessions={[session]} />
  const sessions = card.sessionId && session ? { [card.sessionId]: session } : {}
  const status = failedJob(card.job) ? 'failed' : workerStatus(card.job, sessions)
  return (
    <span className={`status-label health-${(status && JOB_HEALTH[status]) ?? 'waiting'}`}>
      {status && status[0].toUpperCase() + status.slice(1)}
    </span>
  )
}

const AgentNode = memo(function AgentNode({ data: { card }, selected }: NodeProps<AgentFlowNode>) {
  const session = useStore((s) => (card.sessionId ? s.sessions[card.sessionId] : undefined))
  const { select, openTerminal, dismiss } = useContext(AgentActions)
  const name = nameOf(card)
  return (
    <article
      className="agent-card"
      data-card={card.id}
      data-row={card.row}
      data-role={card.roleKey}
      data-session={card.sessionId}
    >
      <Handle
        className="agent-card-handle"
        type="target"
        position={Position.Top}
        isConnectable={false}
      />
      <header>
        <button
          className="agent-card-name"
          aria-label={`Show details for ${name}`}
          aria-expanded={selected}
          onClick={(e) => {
            e.stopPropagation()
            select(card.id)
          }}
        >
          {card.role}
        </button>
        {card.detail && <span className="agent-card-detail">{card.detail}</span>}
      </header>
      <div className="agent-card-snippet">
        {agentSnippet(card, session).map((line, index) => (
          <p key={index} title={line}>
            {line}
          </p>
        ))}
      </div>
      <footer>
        <AgentStatus card={card} session={session} />
        <div className="agent-card-actions">
          <button
            disabled={!card.record}
            aria-label={`View ${name} terminal`}
            onClick={(e) => {
              e.stopPropagation()
              openTerminal(card)
            }}
          >
            Terminal
          </button>
          {card.job && agentDismissible(card) && (
            <button
              aria-label={`Dismiss ${name}`}
              onClick={(e) => {
                e.stopPropagation()
                dismiss(card.job!)
              }}
            >
              Dismiss
            </button>
          )}
        </div>
      </footer>
      <Handle
        className="agent-card-handle"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
      />
    </article>
  )
})

const nodeTypes = { agent: AgentNode }

/** The team's overall state and its dismissed results, under the tabs. */
function TeamStatus({
  team,
  work,
  undo,
  restore,
}: {
  team: ChatTeam
  work: TeamWork
  undo: ProviderJob | undefined
  restore: (job: ProviderJob) => void
}) {
  const { sessions, jobs, dismissed } = work
  // The last dismissal; its button takes focus from the card that went away.
  const undoButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (undo) undoButton.current?.focus()
  }, [undo])
  const active = jobs.some((job) => workerStatus(job, sessions) !== 'complete')
  return (
    <div className="agent-team-status">
      <p role="status">
        {team.state === 'running'
          ? active
            ? Object.entries(workerCounts(jobs, sessions))
                .filter(([, count]) => count > 0)
                .map(([status, count]) => `${count} ${status}`)
                .join(' · ')
            : 'Ready'
          : team.state === 'paused'
            ? work.restartNotice
              ? RESTART_NOTICE
              : 'Paused'
            : team.state === 'stopped'
              ? 'Stopped'
              : 'Complete'}
        {team.reset && !team.reset.error && ' · Restoring context…'}
      </p>
      {undo && dismissed.some((job) => job.id === undo.id) && (
        <p role="status">
          Dismissed {undo.terminal.name}.{' '}
          <button ref={undoButton} onClick={() => restore(undo)}>
            Undo
          </button>
        </p>
      )}
      {dismissed.length > 0 && (
        <details className="chat-workers-dismissed">
          <summary>Dismissed ({dismissed.length})</summary>
          <ul>
            {dismissed.map((job) => (
              <li key={job.id}>
                {job.terminal.name} · {failedJob(job) ? 'failed' : workerStatus(job, sessions)}{' '}
                <button onClick={() => restore(job)}>Restore</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <button onClick={showSessions}>Open Sessions</button>
    </div>
  )
}

function JobDetails({
  team,
  job,
  done,
  dismissible,
  dismiss,
}: {
  team: ChatTeam
  job: ProviderJob
  done: boolean
  dismissible: boolean
  dismiss: (job: ProviderJob) => void
}) {
  const { act, run, busy, error } = useTeamAction(team)
  return (
    <>
      {job.summary && <p>{job.summary}</p>}
      {!(done && job.summary) && <Instructions text={job.instructions} />}
      {job.report && <AssignmentReport report={job.report} />}
      {job.error && <p>{job.error}</p>}
      <div className="chat-workers-actions">
        {failedJob(job) && (
          <>
            <button disabled={busy} onClick={() => void act({ kind: 'retry', assignment: job.id })}>
              Retry work
            </button>
            <RetryOnAgent team={team} job={job} busy={busy} run={run} />
            <button onClick={showSettings}>Agent settings</button>
          </>
        )}
        {dismissible && <button onClick={() => dismiss(job)}>Dismiss</button>}
      </div>
      {error && <p role="alert">{error}</p>}
    </>
  )
}

function AgentDetails({
  card,
  team,
  close,
  dismiss,
}: {
  card: AgentCard
  team: ChatTeam | undefined
  close: () => void
  dismiss: (job: ProviderJob) => void
}) {
  const session = useStore((s) => (card.sessionId ? s.sessions[card.sessionId] : undefined))
  const steps = session?.status?.agent?.state === 'working' ? turnSteps(session) : []
  const reply = session?.replies?.at(-1)?.text
  // Focus follows the panel, so Escape and the keyboard work from the moment it opens.
  const panel = useRef<HTMLElement>(null)
  useEffect(() => panel.current?.focus({ preventScroll: true }), [])
  return (
    <aside
      ref={panel}
      className="agent-details"
      aria-label={`${nameOf(card)} details`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        close()
      }}
    >
      <header>
        <strong className="agent-role" data-role={card.roleKey}>
          {card.role}
        </strong>
        <AgentStatus card={card} session={session} />
        <button aria-label="Close details" onClick={close}>
          ×
        </button>
      </header>
      {card.detail && <p>{card.detail}</p>}
      {steps.length > 0 && (
        <ol>
          {steps.map((step) => (
            <li key={step.sequence}>{activityLabel(step, card.record?.spec.cwd)}</li>
          ))}
        </ol>
      )}
      {card.job && team ? (
        <JobDetails
          team={team}
          job={card.job}
          done={card.row === 'finished'}
          dismissible={agentDismissible(card)}
          dismiss={dismiss}
        />
      ) : (
        reply && <Markdown text={reply} />
      )}
    </aside>
  )
}

/** What the graph draws from; session activity reaches the cards through their own subscriptions. */
const graphKey = (cards: AgentCard[]) =>
  JSON.stringify(
    cards.map(({ id, row, role, roleKey, detail, sessionId, job }) => [
      id,
      row,
      role,
      roleKey,
      detail,
      sessionId,
      job?.requestId,
      job?.state,
      job?.error,
      job?.summary,
    ]),
  )

function AgentGraph({ onOpenTerminal }: { onOpenTerminal: (record: SessionRecord) => void }) {
  const worktree = useContext(SimpleWorktreeContext)
  const { cards, team, work } = useChatAgents(worktree)
  const [selected, setSelected] = useState<string>()
  // The open details' card, read by the stable actions to tell an open from a switch.
  const selectedRef = useRef<string>(undefined)
  const [undo, setUndo] = useState<ProviderJob>()
  const key = graphKey(cards)
  const [shown, setShown] = useState({ key, cards })
  if (shown.key !== key) setShown({ key, cards })
  const canvas = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const measure = () => {
      const { clientWidth: width, clientHeight: height } = element
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const columns = agentColumns(shown.cards, size)
  const { positions, edges } = useMemo(
    () => agentLayout(shown.cards, columns),
    [shown.cards, columns],
  )
  const nodes = useMemo(
    () =>
      positions.map(({ card, x, y }): AgentFlowNode => ({
        id: card.id,
        type: 'agent',
        position: { x, y },
        width: AGENT_CARD_WIDTH,
        height: AGENT_CARD_HEIGHT,
        selected: card.id === selected,
        data: { card },
      })),
    [positions, selected],
  )
  const { fitView, getViewport, setViewport } = useReactFlow()
  const reducedMotion = useReducedMotion()
  const topology = positions.map(({ card, x, y }) => `${card.id}:${x}:${y}`).join('|')
  // Once the person pans or zooms, agents starting and finishing no longer move their view; the
  // fit control hands framing back to the canvas.
  const userMoved = useRef(false)
  const fitted = useRef(false)
  useEffect(() => {
    if (userMoved.current) return
    const frame = requestAnimationFrame(() => {
      // The first fit lands in place; later ones glide to the new arrangement.
      const duration = fitted.current && !reducedMotion ? 300 : 0
      fitted.current = true
      void fitView({ ...FIT_VIEW, duration })
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, topology, size, reducedMotion])
  const { setDismissed } = work
  const dismiss = useCallback(
    (job: ProviderJob) => {
      setDismissed(job, true)
      setUndo(job)
      setSelected((id) => (id === `job:${job.id}` ? undefined : id))
    },
    [setDismissed],
  )
  const actions = useMemo(
    () => ({
      select: (id: string) => {
        // Opening the details slides the panel in from the right edge; switching cards swaps it.
        if (selectedRef.current === undefined)
          transitionPanels(() => setSelected(id), DETAILS_TRANSITIONING)
        else setSelected(id)
        // Slide the chosen card out from under the details panel, keeping its left edge in view.
        const position = positions.find(({ card }) => card.id === id)
        const width = canvas.current?.clientWidth
        if (!position || !width) return
        const { x, y, zoom } = getViewport()
        const panelLeft = width - Math.min(DETAILS_WIDTH, width - 2 * DETAILS_INSET) - DETAILS_INSET
        const left = x + position.x * zoom
        const overlap = left + AGENT_CARD_WIDTH * zoom + DETAILS_INSET - panelLeft
        const shift = Math.min(overlap, left - DETAILS_INSET)
        if (shift > 0)
          void setViewport({ x: x - shift, y, zoom }, { duration: reducedMotion ? 0 : 200 })
      },
      openTerminal: ({ record }: AgentCard) => {
        if (record) onOpenTerminal(record)
      },
      dismiss,
    }),
    [onOpenTerminal, positions, getViewport, setViewport, reducedMotion, dismiss],
  )
  const details = cards.find((card) => card.id === selected)
  useEffect(() => {
    selectedRef.current = details?.id
  })
  // Deferred to the transition, so it clears only the details being closed: a card chosen in the
  // meantime stays open.
  const closeSelection = () => {
    const closing = selectedRef.current
    transitionPanels(
      () => setSelected((id) => (id === closing ? undefined : id)),
      DETAILS_TRANSITIONING,
    )
  }
  const closeDetails = () => {
    if (details)
      canvas.current
        ?.querySelector<HTMLElement>(`[data-card="${CSS.escape(details.id)}"] .agent-card-name`)
        ?.focus({ preventScroll: true })
    closeSelection()
  }
  return (
    <AgentActions value={actions}>
      <div
        className="agent-canvas"
        ref={canvas}
        // Minimap pans and zooms reach d3 without a source event, so they are caught here.
        // A drag on the minimap pans; a plain press there leaves auto-fit alone.
        onPointerMoveCapture={(e) => {
          if (e.buttons && (e.target as Element).closest('.react-flow__minimap'))
            userMoved.current = true
        }}
        onWheelCapture={(e) => {
          if ((e.target as Element).closest('.react-flow__minimap')) userMoved.current = true
        }}
      >
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={FIT_VIEW}
          {...CANVAS_GESTURES}
          onMoveStart={(event) => {
            // Programmatic moves (fits, sliding a card clear of the details) come without an event.
            if (event) userMoved.current = true
          }}
          minZoom={0.3}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 2 } }}
          onNodeClick={(_, node) => actions.select(node.id)}
          onPaneClick={() => {
            if (selectedRef.current !== undefined) closeSelection()
            // A card that left the graph keeps no selection to reopen on its return.
            else setSelected(undefined)
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="color-mix(in srgb, var(--border) 55%, transparent)"
          />
          <Controls
            showInteractive={false}
            className="canvas-controls"
            onFitView={() => {
              userMoved.current = false
            }}
            onZoomIn={() => {
              userMoved.current = true
            }}
            onZoomOut={() => {
              userMoved.current = true
            }}
          >
            <MinimapToggle />
          </Controls>
          <CanvasMinimap nodeColor={minimapColor} />
          {cards.length === 0 && (
            <Panel position="top-center" className="canvas-empty">
              <EmptyState icon="◇" title="No active agents">
                Agents working in this worktree appear here.
              </EmptyState>
            </Panel>
          )}
        </ReactFlow>
        <div className="agent-canvas-top">
          <StoryViewTabs />
          {team && (
            <TeamStatus
              team={team}
              work={work}
              undo={undo}
              restore={(job) => {
                work.setDismissed(job, false)
                setUndo(undefined)
              }}
            />
          )}
        </div>
        {details && (
          <AgentDetails
            key={details.id}
            card={details}
            team={team}
            close={closeDetails}
            dismiss={dismiss}
          />
        )}
      </div>
    </AgentActions>
  )
}

/** The Agents tab has its own flow store and preserves the map's viewport and selection. */
export default function AgentCanvas({
  onOpenTerminal,
}: {
  onOpenTerminal: (record: SessionRecord) => void
}) {
  return (
    <ReactFlowProvider>
      <AgentGraph onOpenTerminal={onOpenTerminal} />
    </ReactFlowProvider>
  )
}
