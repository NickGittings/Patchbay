import { expect, test, vi } from 'vitest'
import type { SessionState, TerminalSpec } from '../types'
import { sessionId, setProjectIdentity } from '../types'

vi.mock('../store', () => ({ useStore: { getState: () => ({}) } }))
const { dockTabs, hasDockTabs, showsInspector } = await import('./panels')

setProjectIdentity('p-1')

const terminal = (id: string): TerminalSpec => ({ id, name: id, command: id, kind: 'task' })
const node = (id: string, terminals: string[]) => ({
  id,
  data: { name: id, terminals: terminals.map(terminal) },
})
const running: SessionState = { running: true }
const exited: SessionState = { running: false, exitCode: 1 }

function state(sessions: Record<string, SessionState>, extra = {}) {
  return {
    nodes: [node('web', ['dev', 'test']), node('api', ['dev'])],
    selectedId: null,
    sessions,
    runtimeTerminals: {},
    activeTask: null,
    dockKept: [],
    project: { id: 'p-1', name: 'p', root: '/p' },
    ...extra,
  } as unknown as Parameters<typeof dockTabs>[0]
}
const labels = (s: Parameters<typeof dockTabs>[0]) => dockTabs(s).map((t) => t.label)

test('the dock lists running sessions, labelled by component when nothing is selected', () => {
  const s = state({ [sessionId('web', 'test')]: running, [sessionId('api', 'dev')]: exited })
  expect(labels(s)).toEqual(['web · test'])
})

test('the exited session the dock showed stays listed', () => {
  const sid = sessionId('web', 'test')
  expect(labels(state({ [sid]: exited }))).toEqual([])
  expect(labels(state({ [sid]: exited }, { dockKept: [sid] }))).toEqual(['web · test'])
})

test('a selected component without running sessions keeps the project-wide tabs', () => {
  const sessions = { [sessionId('web', 'test')]: running }
  expect(labels(state(sessions, { selectedId: 'api' }))).toEqual(['web · test'])
  expect(labels(state(sessions, { selectedId: 'web' }))).toEqual(['test'])
})

test('the inspector follows the selection unless opened or closed', () => {
  const map = { nodes: [node('web', [])], edges: [] } as unknown as Pick<
    Parameters<typeof showsInspector>[0],
    'nodes' | 'edges'
  >
  const sel = { selectedId: 'web', selectedEdgeId: null, ...map }
  expect(showsInspector({ inspector: null, ...sel })).toBe(true)
  expect(showsInspector({ inspector: false, ...sel })).toBe(false)
  expect(showsInspector({ inspector: null, selectedId: null, selectedEdgeId: null, ...map })).toBe(
    false,
  )
  expect(showsInspector({ ...sel, inspector: null, selectedId: 'gone' })).toBe(false)
  expect(showsInspector({ ...sel, inspector: true, selectedId: null })).toBe(true)
})

test('hasDockTabs agrees with dockTabs', () => {
  const sid = sessionId('web', 'test')
  for (const s of [
    state({}),
    state({ [sid]: running }),
    state({ [sid]: exited }),
    state({ [sid]: exited }, { dockKept: [sid] }),
    state({ [sessionId('web', 'test', 'other-task')]: running }),
    state({ [sessionId('gone', 'dev')]: running }),
  ])
    expect(hasDockTabs(s)).toBe(dockTabs(s).length > 0)
})

test('merge and planner sessions never enter Navigation, even when running or retained', () => {
  for (const componentId of ['@merge', '@plan']) {
    for (const session of [running, exited]) {
      const s = state(
        { merge: session },
        {
          dockKept: ['merge'],
          runtimeTerminals: {
            merge: { projectId: 'p-1', taskId: null, componentId, terminal: terminal('merge') },
          },
        },
      )
      expect(dockTabs(s)).toEqual([])
      expect(hasDockTabs(s)).toBe(false)
    }
  }
})
