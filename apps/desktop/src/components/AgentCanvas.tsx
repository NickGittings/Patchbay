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
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import type { SessionState } from '../types'
import { activityLabel, turnSteps } from '../lib/activity'
import {
  AGENT_CARD_HEIGHT,
  AGENT_CARD_WIDTH,
  agentLayout,
  agentSnippet,
  type AgentCard,
} from '../lib/chatAgents'
import { failedJob, workerCounts, workerStatus } from '../lib/chatProgress'
import { RESTART_NOTICE, type ChatTeam } from '../lib/chatTeams'
import type { Health } from '../lib/display'
import type { ProviderJob } from '../lib/orchestration'
import { pinChatTerminal, simpleKey } from '../lib/simpleUi'
import { useChatAgents } from '../lib/useChatAgents'
import { useReducedMotion } from '../lib/useReducedMotion'
import { useTeamAction, type TeamWork } from '../lib/useTeamWork'
import {
  AssignmentReport,
  Instructions,
  RetryOnAgent,
  showSessions,
  showSettings,
} from './ChatCoordination'
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
}>({ select: () => {}, openTerminal: () => {} })

const nameOf = ({ role, detail }: AgentCard) => (detail ? `${role} ${detail}` : role)

/** Keeps cards clear of the tabs and team status that float over the canvas's top edge. */
const FIT_VIEW: FitViewOptions = {
  padding: { top: '96px', right: 0.2, bottom: 0.2, left: 0.2 },
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
  const { select, openTerminal } = useContext(AgentActions)
  const name = nameOf(card)
  return (
    <article
      className="agent-card"
      data-card={card.id}
      data-row={card.row}
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
  dismiss,
}: {
  team: ChatTeam
  job: ProviderJob
  done: boolean
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
        {(done || failedJob(job)) && <button onClick={() => dismiss(job)}>Dismiss</button>}
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
        <strong>{card.role}</strong>
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
        <JobDetails team={team} job={card.job} done={card.row === 'finished'} dismiss={dismiss} />
      ) : (
        reply && <Markdown text={reply} />
      )}
    </aside>
  )
}

/** What the graph draws from; session activity reaches the cards through their own subscriptions. */
const graphKey = (cards: AgentCard[]) =>
  JSON.stringify(
    cards.map(({ id, row, role, detail, sessionId, job }) => [
      id,
      row,
      role,
      detail,
      sessionId,
      job?.state,
      job?.error,
      job?.summary,
    ]),
  )

function AgentGraph({ onShowChat }: { onShowChat?: () => void }) {
  const worktree = useContext(SimpleWorktreeContext)
  const { cards, team, work } = useChatAgents(worktree)
  const scopeKey = useStore((s) => simpleKey(s.project?.id, s.activeTask))
  const [selected, setSelected] = useState<string>()
  const [undo, setUndo] = useState<ProviderJob>()
  const key = graphKey(cards)
  const [shown, setShown] = useState({ key, cards })
  if (shown.key !== key) setShown({ key, cards })
  const { positions, edges } = useMemo(() => agentLayout(shown.cards), [shown.cards])
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
  const canvas = useRef<HTMLDivElement>(null)
  const reducedMotion = useReducedMotion()
  const topology = positions.map(({ card }) => `${card.id}:${card.row}`).join('|')
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void fitView(FIT_VIEW)
    })
    return () => cancelAnimationFrame(frame)
  }, [fitView, topology])
  const actions = useMemo(
    () => ({
      select: (id: string) => {
        setSelected(id)
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
      openTerminal: ({ sessionId }: AgentCard) => {
        if (!sessionId) return
        pinChatTerminal(scopeKey, sessionId, useStore.getState().sessions[sessionId]?.generation)
        onShowChat?.()
      },
    }),
    [scopeKey, onShowChat, positions, getViewport, setViewport, reducedMotion],
  )
  const details = cards.find((card) => card.id === selected)
  const closeDetails = () => {
    if (details)
      canvas.current
        ?.querySelector<HTMLElement>(`[data-card="${CSS.escape(details.id)}"] .agent-card-name`)
        ?.focus({ preventScroll: true })
    setSelected(undefined)
  }
  return (
    <AgentActions value={actions}>
      <div className="agent-canvas" ref={canvas}>
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={FIT_VIEW}
          minZoom={0.3}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          defaultEdgeOptions={{ type: 'smoothstep', style: { strokeWidth: 2 } }}
          onNodeClick={(_, node) => actions.select(node.id)}
          onPaneClick={() => setSelected(undefined)}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color="color-mix(in srgb, var(--border) 55%, transparent)"
          />
          <Controls showInteractive={false} className="canvas-controls" />
          {cards.length === 0 && (
            <Panel position="top-center" className="canvas-empty">
              <EmptyState icon="◇" title="No active agents">
                Agents this chat starts appear here.
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
            dismiss={(job) => {
              work.setDismissed(job, true)
              setUndo(job)
              setSelected(undefined)
            }}
          />
        )}
      </div>
    </AgentActions>
  )
}

/** Chat's Agents tab. Its own flow store, so the map's viewport and selection stay untouched. */
export default function AgentCanvas({ onShowChat }: { onShowChat?: () => void }) {
  return (
    <ReactFlowProvider>
      <AgentGraph onShowChat={onShowChat} />
    </ReactFlowProvider>
  )
}
