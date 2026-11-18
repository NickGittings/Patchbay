import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import {
  MERGE_SCOPE,
  REVIEW_SCOPE,
  sessionId,
  type Project,
  type SessionRecord,
  type Task,
} from '../types'
import { agentSearchResults, liveAgentIds, openAgentResult } from './agentSearch'
import { refreshSession } from './sessions'

vi.mock('./ipc', () => ({ quitPatchbay: vi.fn(), workspaceLoad: vi.fn(), workspaceSave: vi.fn() }))
vi.mock('./windows', () => ({ openComponentWindow: vi.fn() }))
vi.mock('./sessions', () => ({ refreshSession: vi.fn(), reconcileSessions: vi.fn() }))

const terminal = { id: 'claude', name: 'Claude', command: 'claude', kind: 'agent' as const }
const project = (id: string): Project => ({
  projectId: id,
  name: `Project ${id}`,
  root: `/${id}`,
  schemaVersion: 4,
  links: [],
  components: [
    {
      id: 'web',
      name: 'Web',
      path: '.',
      kind: 'app',
      notes: '',
      position: { x: 0, y: 0 },
      terminals: [terminal, { ...terminal, id: 'shell', name: 'Shell', kind: 'shell' }],
    },
  ],
})
const task = (id: string): Task => ({
  id,
  title: `Task ${id}`,
  worktree: `/worktrees/${id}`,
  branch: `branch-${id}`,
  components: ['web'],
  notes: '',
  createdMs: 1,
  missing: false,
  current: false,
})

function record(
  projectId: string,
  options: {
    componentId?: string
    terminalId?: string
    task?: string | null
    kind?: SessionRecord['metadata']['kind']
    running?: boolean
    startedMs?: number
  } = {},
): SessionRecord {
  const { componentId = 'web', terminalId = 'claude', task = null, kind = 'agent' } = options
  const id = sessionId(componentId, terminalId, task, projectId)
  const r: SessionRecord = {
    id,
    metadata: {
      projectId,
      projectRoot: `/${projectId}`,
      projectName: `Project ${projectId}`,
      componentId,
      terminalId,
      task,
      name: terminalId === 'shell' ? 'Shell' : 'Claude',
      kind,
      adapter: 'claude',
      conversationId: null,
    },
    snapshot: {
      data: '',
      end: 0,
      truncated: false,
      running: options.running ?? true,
      generation: 1,
      startedMs: options.startedMs ?? 1,
      exitedMs: null,
      exitCode: null,
      status: {
        lastOutputMs: null,
        active: false,
        agent: null,
        url: null,
        ready: false,
        healthy: null,
        stopped: false,
        seenMs: null,
      },
      notice: null,
    },
    spec: { cwd: task ? `/worktrees/${task}` : `/${projectId}`, command: 'claude' },
    history: [],
    interrupted: false,
  }
  useStore.setState((s) => ({ sessionRecords: [...s.sessionRecords, r] }))
  return r
}

const search = (query: string) => {
  const s = useStore.getState()
  return agentSearchResults(s, query, liveAgentIds(s))
}

beforeEach(() => {
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  const s = useStore.getState()
  s.loadProject(project('other'))
  useStore.getState().patchProject('other', { tasks: [task('t2')] })
  useStore.getState().loadProject(project('here'))
  useStore.getState().patchProject('here', { tasks: [task('t1')] })
})

test('finds agents in every open project and worktree, naming where each runs', () => {
  record('here')
  record('here', { task: 't1' })
  record('other', { task: 't2' })
  expect(search('builder').map((r) => [r.title, r.detail])).toEqual([
    ['Builder · Web · Claude', 'Project here · Main worktree'],
    ['Builder · Web · Claude', 'Project here · Task t1 · branch-t1'],
    ['Builder · Web · Claude', 'Project other · Task t2 · branch-t2'],
  ])
})

test('every word must match', () => {
  record('here')
  record('other', { task: 't2' })
  expect(search('builder other').map((r) => r.record.metadata.projectId)).toEqual(['other'])
  expect(search('builder nothing')).toEqual([])
  expect(search('   ')).toEqual([])
})

test('only whole words naming an agent of the open project count as naming it', () => {
  record('here')
  expect(search('BUILDER web')[0].named).toBe(true)
  // Listed, but these are as likely to be file queries.
  for (const query of ['ui', 'la', 'build', 'web', 'claude', 'project here'])
    expect(search(query)[0].named).toBe(false)
})

test('an agent in another project is never named, so Enter cannot switch project', () => {
  record('other', { task: 't2' })
  expect(search('builder')[0].named).toBe(false)
})

test('a Chat agent is placed in the worktree opening it reaches', () => {
  const merge = record('here', { componentId: MERGE_SCOPE, terminalId: 'merge' })
  useStore.setState((s) => ({
    simpleMode: true,
    sessionRecords: s.sessionRecords.map((r) =>
      r.id === merge.id ? { ...r, spec: { ...r.spec, merge_source: '/worktrees/t1' } } : r,
    ),
  }))
  expect(search('merge agent')[0].detail).toBe('Project here · Task t1 · branch-t1')
})

test('workflow agents keep their own role', () => {
  record('here', { componentId: REVIEW_SCOPE })
  expect(search('builder')).toEqual([])
  expect(search('reviewer').map((r) => r.title)).toEqual(['Reviewer · Claude'])
})

test('leaves out shells, exited agents and projects with no open tab', () => {
  record('here', { terminalId: 'shell', kind: 'shell' })
  record('other', { running: false })
  record('closed')
  expect(search('web')).toEqual([])
  // This window's live state wins over the retained record.
  const exited = record('here')
  useStore.getState().setSession(exited.id, { running: false, generation: 1 })
  expect(search('web')).toEqual([])
})

test('orders the open worktree, the open project, then others, newest first', () => {
  const far = record('other', { startedMs: 9 })
  const task = record('here', { task: 't1', startedMs: 5 })
  const older = record('here', { startedMs: 1 })
  const newer = record('here', { terminalId: 'second', startedMs: 3 })
  useStore.getState().patchProject('here', {
    nodes: useStore.getState().nodes.map((n) => ({
      ...n,
      data: { ...n.data, terminals: [...n.data.terminals, { ...terminal, id: 'second' }] },
    })),
  })
  expect(search('builder').map((r) => r.record.id)).toEqual([newer.id, older.id, task.id, far.id])
})

test('opening a result switches project, and an ended agent explains itself', async () => {
  const agent = record('other', { task: 't2' })
  vi.mocked(refreshSession).mockResolvedValue(agent.snapshot)
  useStore.getState().setSession(agent.id, { running: true, generation: 1 })
  await expect(openAgentResult(agent)).resolves.toBe(true)
  expect(useStore.getState().project?.id).toBe('other')
  expect(useStore.getState().activeTask).toBe('t2')
  expect(useStore.getState().activeSession).toBe(agent.id)

  vi.mocked(refreshSession).mockResolvedValue(null)
  await expect(openAgentResult(agent)).resolves.toBe(false)
  expect(useStore.getState().message).toContain('no longer running')
})
