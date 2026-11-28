import { expect, test } from 'vitest'
import { PLAN_SCOPE, type SessionRecord, type SessionState } from '../types'
import {
  agentColumns,
  agentDismissible,
  agentLayout,
  agentSnippet,
  chatAgentCards,
  type AgentCard,
} from './chatAgents'
import type { ChatTeam } from './chatTeams'
import type { ProviderJob, ProviderRun } from './orchestration'

const worktree = { projectId: 'p', task: 't', path: '/w' }
const record = (id: string, metadata = {}): SessionRecord =>
  ({
    id,
    history: [],
    spec: { cwd: '/w', command: 'agent' },
    metadata: { projectId: 'p', kind: 'agent', componentId: '@task', task: 't', ...metadata },
  }) as unknown as SessionRecord
const running = (extra: Partial<SessionState> = {}): SessionState => ({
  running: true,
  generation: 1,
  ...extra,
})
const job = (id: string, state: ProviderJob['state'], extra = {}): ProviderJob =>
  ({
    id,
    state,
    sessionId: null,
    error: null,
    summary: null,
    instructions: `Do ${id}\nmore`,
    terminal: { name: `Preset ${id}` },
    ...extra,
  }) as ProviderJob
const team = { id: 'team', task: 't', lead: { sessionId: 'lead' } } as unknown as ChatTeam
const cards = (
  records: SessionRecord[],
  sessions: Record<string, SessionState>,
  jobs: ProviderJob[] = [],
  allJobs = jobs,
  withTeam = true,
) =>
  chatAgentCards({
    records,
    sessions,
    simple: null,
    worktree,
    team: withTeam ? team : undefined,
    teams: withTeam ? [team] : [],
    runs: [{ chatTeam: 'team', jobs: allJobs } as ProviderRun],
    jobs,
    allJobs,
  })

test('shows running agents of this chat and every undismissed assignment', () => {
  const worker = record('worker', { task: 'isolated-worker-task' })
  const result = cards(
    [
      record('lead'),
      worker,
      record('other-task', { task: 'elsewhere' }),
      record('exited'),
      record('planner', { componentId: PLAN_SCOPE, task: undefined }),
    ],
    {
      lead: running(),
      worker: running(),
      'other-task': running(),
      exited: { running: false },
      planner: running(),
    },
    [
      job('active', 'running', { sessionId: 'worker' }),
      job('queued', 'pending'),
      job('done', 'integrated', { summary: 'Finished it' }),
    ],
  )
  expect(result.map((c) => [c.id, c.row])).toEqual([
    ['session:lead', 'lead'],
    ['job:active', 'worker'],
    ['job:queued', 'worker'],
    ['job:done', 'finished'],
  ])
  expect(result.slice(1).map((c) => c.role)).toEqual(['Sub-builder', 'Sub-builder', 'Sub-builder'])
  expect(result.map((c) => c.roleKey)).toEqual(['lead', 'subBuilder', 'subBuilder', 'subBuilder'])
  expect(result[2].detail).toBe('Preset queued')
})

test("a dismissed job's session does not come back as a separate agent", () => {
  const dismissed = job('gone', 'integrated', { sessionId: 'worker' })
  expect(
    cards([record('worker')], { worker: running() }, [], [dismissed]).map((c) => c.id),
  ).toEqual([])
})

test('Navigation includes shared planners from its project', () => {
  const records = [
    record('shared', { componentId: PLAN_SCOPE, task: undefined }),
    record('other-task', { componentId: PLAN_SCOPE, task: 'elsewhere' }),
    record('other-project', { componentId: PLAN_SCOPE, projectId: 'elsewhere', task: undefined }),
  ]
  const sessions = Object.fromEntries(records.map(({ id }) => [id, running()]))
  expect(
    chatAgentCards({
      records,
      sessions,
      simple: null,
      worktree,
      team: undefined,
      teams: [],
      runs: [],
      jobs: [],
      allJobs: [],
      includeSharedPlanners: true,
    }).map((c) => c.id),
  ).toEqual(['session:shared'])
})

const card = (extra: Partial<AgentCard>) => extra as AgentCard

test('the snippet leads with what most needs saying', () => {
  const working = running({
    activity: [1, 2, 3, 4].map((sequence) => ({
      sequence,
      atMs: sequence,
      tool: 'Custom',
      target: `step ${sequence}`,
      turn: null,
    })),
    status: { agent: { state: 'working' } } as SessionState['status'],
  })
  expect(agentSnippet(card({}), working)).toEqual([
    'Custom step 4',
    'Custom step 3',
    'Custom step 2',
  ])
  const asking = running({
    status: { agent: { state: 'needsInput', message: 'Allow this?' } } as SessionState['status'],
  })
  expect(agentSnippet(card({ job: job('a', 'failed', { error: 'Boom' }) }), asking)).toEqual([
    'Allow this?',
  ])
  expect(agentSnippet(card({ job: job('a', 'failed', { error: 'Boom' }) }), working)).toEqual([
    'Boom',
  ])
  expect(
    agentSnippet(card({ job: job('a', 'integrated', { summary: 'Shipped' }) }), undefined),
  ).toEqual(['Shipped'])
  expect(agentSnippet(card({ job: job('a', 'pending') }), undefined)).toEqual(['Do a'])
  expect(
    agentSnippet(
      card({}),
      running({ replies: [{ sequence: 1, atMs: 1, turn: null, text: '\n## All done\nDetails' }] }),
    ),
  ).toEqual(['All done'])
  expect(agentSnippet(card({}), running())).toEqual(['No activity yet'])
})

test('layout stacks rows and joins the lead to active workers only', () => {
  const row = (id: string, r: AgentCard['row']) => card({ id, row: r })
  const { positions, edges } = agentLayout([
    row('lead', 'lead'),
    row('a', 'worker'),
    row('b', 'worker'),
    row('done', 'finished'),
  ])
  const y = (id: string) => positions.find((p) => p.card.id === id)!.y
  expect(y('lead')).toBeLessThan(y('a'))
  expect(y('a')).toBe(y('b'))
  expect(y('b')).toBeLessThan(y('done'))
  expect(edges.map((e) => e.target)).toEqual(['a', 'b'])
  expect(agentLayout([row('solo', 'other'), row('two', 'other')]).edges).toEqual([])
})

const workers = (count: number) =>
  Array.from({ length: count }, (_, i) => card({ id: `w${i}`, row: 'worker' }))

test('layout wraps long rows and keeps each line centered', () => {
  const { positions, width, height } = agentLayout(workers(3), 2)
  expect(new Set(positions.map((p) => p.y)).size).toBe(2)
  expect(positions[2].x).toBe(-170)
  expect(width).toBe(704)
  expect(height).toBe(304)
})

test('columns follow the canvas so cards stay as large as they can', () => {
  expect(agentColumns(workers(6), { width: 1200, height: 700 })).toBe(3)
  expect(agentColumns(workers(6), { width: 400, height: 800 })).toBe(1)
  expect(agentColumns(workers(2), { width: 0, height: 0 })).toBe(Infinity)
})

test('only finished or failed assignments can be dismissed', () => {
  expect(agentDismissible(card({ row: 'finished', job: job('a', 'integrated') }))).toBe(true)
  expect(agentDismissible(card({ row: 'worker', job: job('a', 'failed') }))).toBe(true)
  expect(agentDismissible(card({ row: 'worker', job: job('a', 'running') }))).toBe(false)
  expect(agentDismissible(card({ row: 'other' }))).toBe(false)
})

test('the project’s Agents show every worktree’s agents, each saying where it works', () => {
  const lead = record('lead', { task: null })
  const result = chatAgentCards({
    records: [
      lead,
      record('builder', { task: 'login' }),
      record('reviewer', { task: 'search' }),
      record('shell', { task: 'login', kind: 'shell' }),
    ],
    sessions: { lead: running(), builder: running(), reviewer: running(), shell: running() },
    simple: null,
    worktree: { projectId: 'p', task: null, path: '/p' },
    team: { ...team, task: null } as ChatTeam,
    teams: [{ ...team, task: null } as ChatTeam],
    runs: [],
    jobs: [],
    allJobs: [],
    project: true,
    placeOf: (task) => (task ? `${task} · feat/${task}` : 'Project folder · main'),
  })
  expect(result.map((c) => [c.sessionId, c.place])).toEqual([
    ['lead', 'Project folder · main'],
    ['builder', 'login · feat/login'],
    ['reviewer', 'search · feat/search'],
  ])
  // Each worktree's agents sit on their own rows below the lead.
  const rows = agentLayout(result).positions.map((p) => [p.card.sessionId, p.y])
  expect(new Set(rows.map(([, y]) => y)).size).toBe(3)
})
