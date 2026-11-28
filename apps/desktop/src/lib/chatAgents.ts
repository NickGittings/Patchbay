import type { SessionRecord, SessionState } from '../types'
import { activityLabel, turnSteps } from './activity'
import { failedJob, workerSession, workerStatus } from './chatProgress'
import { chatIdentity, ROLE_LABELS, type ChatRoleKey } from './chatIdentity'
import type { ChatTeam } from './chatTeams'
import type { ProviderJob, ProviderRun } from './orchestration'
import { foreignPlanner, relatedSession, type SimpleState, type SimpleWorktree } from './simple'

export type AgentRow = 'lead' | 'worker' | 'other' | 'finished'

/** One agent on the Agents canvas: a session, a team assignment, or both. */
export interface AgentCard {
  id: string
  sessionId?: string
  record?: SessionRecord
  job?: ProviderJob
  row: AgentRow
  role: string
  roleKey: ChatRoleKey
  detail: string
  /** The worktree the agent works in (its task; null for the project folder). */
  worktree: string | null
  /** That worktree's name and branch, so a card always says where the agent works. */
  place: string
  /** It works in the worktree in focus. */
  focused?: boolean
}

/**
 * Who the Agents tab shows: the team's undismissed assignments, whatever their state, and every
 * other running agent in scope. A job's session appears only through its job.
 */
export function chatAgentCards({
  records,
  sessions,
  simple,
  worktree,
  team,
  teams,
  runs,
  jobs,
  allJobs,
  includeSharedPlanners = false,
  project = false,
  placeOf = () => '',
}: {
  records: readonly SessionRecord[]
  sessions: Record<string, SessionState>
  simple: SimpleState | null | undefined
  worktree: SimpleWorktree
  team: ChatTeam | undefined
  teams: readonly ChatTeam[] | undefined
  runs: readonly ProviderRun[] | undefined
  jobs: readonly ProviderJob[]
  allJobs: readonly ProviderJob[]
  includeSharedPlanners?: boolean
  /** Every running agent of the project, in any worktree: the project's lead works in all. */
  project?: boolean
  /** A worktree's label: its name and branch. */
  placeOf?: (task: string | null) => string
}): AgentCard[] {
  const identity = (record: SessionRecord | undefined) => chatIdentity(record, teams, runs)
  const sessionCard = (record: SessionRecord): AgentCard => {
    const { role, roleKey, detail } = identity(record)
    const task = record.metadata.task ?? null
    return {
      worktree: task,
      place: placeOf(task),
      id: `session:${record.id}`,
      sessionId: record.id,
      record,
      row:
        roleKey === 'lead'
          ? 'lead'
          : roleKey === 'builder' || roleKey === 'subBuilder'
            ? 'worker'
            : 'other',
      role,
      roleKey,
      detail,
    }
  }
  const started = (record: SessionRecord) =>
    (sessions[record.id] ?? record.snapshot)?.startedMs ?? 0
  const jobSessions = new Set(allJobs.flatMap((job) => job.sessionId ?? []))
  const running = records
    .filter(
      (record) =>
        sessions[record.id]?.running &&
        !jobSessions.has(record.id) &&
        (record.id === team?.lead.sessionId ||
          (project
            ? record.metadata.projectId === worktree.projectId && record.metadata.kind === 'agent'
            : relatedSession(record, worktree, sessions[record.id]?.generation, simple) &&
              (includeSharedPlanners || !foreignPlanner(record, sessions, simple)))),
    )
    .toSorted((a, b) => started(a) - started(b) || a.id.localeCompare(b.id))
    .map(sessionCard)
  const jobCards = jobs.map((job): AgentCard => {
    const record = workerSession(job, records as SessionRecord[], worktree.projectId)
    const known = record && identity(record)
    const task = record?.metadata.task ?? job.task ?? null
    return {
      worktree: task,
      place: placeOf(task),
      id: `job:${job.id}`,
      sessionId: record?.id,
      record,
      job,
      row: workerStatus(job, sessions) === 'complete' ? 'finished' : 'worker',
      role: known?.role ?? ROLE_LABELS.subBuilder,
      roleKey: known?.roleKey ?? 'subBuilder',
      detail: known?.detail || job.terminal.name,
    }
  })
  return [
    ...running.filter((c) => c.row === 'lead'),
    ...jobCards,
    ...running.filter((c) => c.row !== 'lead'),
  ]
}

/** Finished or failed work the user can clear from the canvas; coordination keeps the record. */
export const agentDismissible = ({ job, row }: Pick<AgentCard, 'job' | 'row'>) =>
  !!job && (row === 'finished' || failedJob(job))

const SNIPPET_LENGTH = 180

/** The first line with words in it, without its Markdown lead-in. */
function firstLine(text: string | null | undefined) {
  const line = text
    ?.split('\n')
    .map((l) => l.replace(/^[\s#>*-]+/, '').trim())
    .find(Boolean)
  return line && line.length > SNIPPET_LENGTH ? `${line.slice(0, SNIPPET_LENGTH)}…` : line
}

/** What a card says the agent is doing, most relevant line first. */
export function agentSnippet(
  { job, record }: Pick<AgentCard, 'job' | 'record'>,
  session: SessionState | undefined,
): string[] {
  const agent = session?.running ? session.status?.agent : undefined
  if (agent?.state === 'needsInput')
    return [
      firstLine(agent.message) ??
        firstLine(agent.questions?.[0]?.question) ??
        'Waiting for your input',
    ]
  if (job && failedJob(job)) return [firstLine(job.error) ?? 'Failed']
  if (agent?.state === 'working') {
    const steps = turnSteps(session).slice(-3).toReversed()
    return steps.length ? steps.map((step) => activityLabel(step, record?.spec.cwd)) : ['Working…']
  }
  const instructions = firstLine(job?.instructions)
  if (job && ['complete', 'integrated'].includes(job.state) && job.summary)
    return [firstLine(job.summary)!]
  if (job && ['pending', 'launching'].includes(job.state) && instructions) return [instructions]
  const reply = firstLine(session?.replies?.at(-1)?.text) ?? instructions
  return [reply ?? 'No activity yet']
}

export const AGENT_CARD_WIDTH = 340
export const AGENT_CARD_HEIGHT = 140
/** Canvas kept clear around the cards; the top holds the floating tabs and team status. */
export const AGENT_CANVAS_INSET = { top: 96, side: 24, bottom: 32 }
const GAP_X = 24
const GAP_Y = 64
const WRAP_GAP = 24
const ROWS: AgentRow[] = ['lead', 'worker', 'other', 'finished']

/**
 * The canvas's rows, top to bottom: the lead, then each worktree's agents together (the project
 * folder's first, then the others in the order they appear), split by row kind.
 */
function agentRows(cards: readonly AgentCard[]) {
  const places = [
    ...new Set(
      cards
        .filter((card) => card.row !== 'lead')
        .toSorted((a, b) => Number(a.worktree !== null) - Number(b.worktree !== null))
        .map((card) => card.worktree),
    ),
  ]
  return [
    cards.filter((card) => card.row === 'lead'),
    ...places.flatMap((place) =>
      ROWS.filter((row) => row !== 'lead').map((row) =>
        cards.filter((card) => card.row === row && card.worktree === place),
      ),
    ),
  ].filter((members) => members.length)
}

/**
 * Cards in centered rows, top to bottom, each wrapping at `columns`, with the lead joined to its
 * active workers. Each worktree's agents stay together.
 */
export function agentLayout(cards: readonly AgentCard[], columns = Infinity) {
  const positions: { card: AgentCard; x: number; y: number }[] = []
  let y = 0
  let width = 0
  for (const members of agentRows(cards)) {
    for (let start = 0; start < members.length; start += columns) {
      const line = members.slice(start, start + columns)
      const lineWidth = line.length * AGENT_CARD_WIDTH + (line.length - 1) * GAP_X
      width = Math.max(width, lineWidth)
      line.forEach((card, index) =>
        positions.push({
          card,
          x: index * (AGENT_CARD_WIDTH + GAP_X) - lineWidth / 2,
          y,
        }),
      )
      y += AGENT_CARD_HEIGHT + WRAP_GAP
    }
    y += GAP_Y - WRAP_GAP
  }
  const lead = cards.find((card) => card.row === 'lead')
  const edges = lead
    ? cards
        .filter((card) => card.row === 'worker')
        .map((card) => ({ id: `${lead.id}>${card.id}`, source: lead.id, target: card.id }))
    : []
  return { positions, edges, width, height: positions.length ? y - GAP_Y : 0 }
}

/** The wrap that shows cards largest in a canvas of this size, preferring fewer lines on a tie. */
export function agentColumns(
  cards: readonly AgentCard[],
  { width, height }: { width: number; height: number },
) {
  if (!width || !height) return Infinity
  const widest = Math.max(1, ...agentRows(cards).map((members) => members.length))
  const availableWidth = width - 2 * AGENT_CANVAS_INSET.side
  const availableHeight = height - AGENT_CANVAS_INSET.top - AGENT_CANVAS_INSET.bottom
  let best = 1
  let bestZoom = 0
  for (let columns = 1; columns <= widest; columns++) {
    const size = agentLayout(cards, columns)
    const zoom = Math.min(1, availableWidth / size.width, availableHeight / size.height)
    if (zoom >= bestZoom) {
      best = columns
      bestZoom = zoom
    }
  }
  return best
}
