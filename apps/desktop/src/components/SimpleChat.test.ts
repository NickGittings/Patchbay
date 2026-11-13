import { beforeEach, expect, test, vi } from 'vitest'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { useStore } from '../store'
import { simpleKey, useSimpleUi } from '../lib/simpleUi'
import type { useSimpleData } from '../lib/useSimpleData'
import SimpleChat from './SimpleChat'
import SimpleDiff from './SimpleDiff'
import FindingsPanel from './findings/FindingsPanel'
import DiffView from './changes/DiffView'

vi.mock('../lib/windows', () => ({ showsSession: vi.fn(), openComponentWindow: vi.fn() }))
vi.mock('../lib/clock', () => ({ useClockNow: () => 0, useExpiredDeadline: () => 0 }))
vi.mock('zustand/react/shallow', () => ({ useShallow: (select: unknown) => select }))
vi.mock('../lib/agentHooks', async (original) => ({
  ...(await original<typeof import('../lib/agentHooks')>()),
  useAgentHooksInstalled: () => ({}),
  usePresetProviders: () => [],
}))
vi.mock('../lib/chatTeams', async (original) => {
  const actual = await original<typeof import('../lib/chatTeams')>()
  return {
    ...actual,
    useChatTeams: Object.assign(
      (select: (s: ReturnType<typeof actual.useChatTeams.getState>) => unknown) =>
        select(actual.useChatTeams.getState()),
      actual.useChatTeams,
    ),
  }
})
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: () => {},
  useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()],
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))
vi.mock('../store', async (original) => {
  const actual = await original<typeof import('../store')>()
  return {
    ...actual,
    useStore: Object.assign(
      (select: (s: ReturnType<typeof actual.useStore.getState>) => unknown) =>
        select(actual.useStore.getState()),
      actual.useStore,
    ),
  }
})
vi.mock('../lib/simpleUi', async (original) => {
  const actual = await original<typeof import('../lib/simpleUi')>()
  return {
    ...actual,
    useSimpleUi: Object.assign(
      (select: (s: ReturnType<typeof actual.useSimpleUi.getState>) => unknown) =>
        select(actual.useSimpleUi.getState()),
      actual.useSimpleUi,
    ),
  }
})

function element(
  node: ReactNode,
  type: unknown,
): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) return node.map((child) => element(child, type)).find(Boolean)
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined
  if (node.type === type) return node as ReactElement<Record<string, unknown>>
  return element(node.props.children, type)
}

beforeEach(() => {
  useStore.setState(useStore.getInitialState())
  useSimpleUi.setState({ worktrees: {} })
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/repo',
    name: 'P',
    schemaVersion: 4,
    components: [
      {
        id: 'app',
        name: 'App',
        path: 'src',
        kind: 'app',
        notes: '',
        position: { x: 0, y: 0 },
        terminals: [],
      },
    ],
    links: [],
  })
  useStore.setState({
    simple: {
      startedMs: 1,
      log: [
        {
          id: 'review',
          atMs: 2,
          kind: 'action',
          stage: 'review',
          action: 'review',
          sessionId: 'reviewer',
        },
      ],
    },
    sessionRecords: [
      {
        id: 'reviewer',
        metadata: {
          projectId: 'p',
          kind: 'agent',
          componentId: '@review',
          task: null,
          name: 'Reviewer',
          adapter: 'codex',
        },
        spec: { cwd: '/repo', command: 'codex' },
        snapshot: { startedMs: 2 },
        history: [],
      },
    ] as never,
  })
})

test('a finding clicked while artifacts reload opens its committed component diff when they arrive', () => {
  const reader = {
    data: undefined,
    source: { path: '/repo', branch: 'feature', current: true, head: 'head' },
    scope: { projectId: 'p', task: null, path: '/repo', branch: 'feature' },
    worktrees: [],
    branches: ['main', 'feature'],
    groups: [],
    files: [],
    error: '',
    findings: {
      key: 'p',
      findings: {
        base: 'main',
        modifiedMs: 3,
        startedMs: 2,
        text: '[high] src/app.txt:1: Fix the fixture.',
        reviewers: [],
        verdict: { clean: false, counts: { critical: 0, high: 1, medium: 0, low: 0 } },
      },
    },
  } as unknown as ReturnType<typeof useSimpleData>
  const chat = SimpleChat({ reader, onHide: () => {} })
  const panel = element(chat, FindingsPanel)
  expect(panel).toBeDefined()
  ;(panel!.props.onOpenFile as (ref: { path: string; line: number }) => void)({
    path: 'src/app.txt',
    line: 1,
  })
  const scopeKey = simpleKey('p', null)
  const selection = useSimpleUi.getState().worktrees[scopeKey].diff
  const file = { path: 'src/app.txt', kind: 'modified' as const }
  const loaded = {
    ...reader,
    base: 'main',
    data: { review: { changes: { app: [file] } } },
    files: [{ componentId: 'app', path: file.path }],
  } as unknown as ReturnType<typeof useSimpleData>
  const diff = element(SimpleDiff({ scopeKey, selection, reader: loaded }), DiffView)
  expect(diff, `finding selection: ${JSON.stringify(selection)}`).toBeDefined()
  expect(diff!.props).toMatchObject({ file, componentId: 'app', base: 'main', lineFocus: 1 })
  expect(diff!.props.nav).toMatchObject({ position: 0, total: 1 })
})

test('an explicit listed component stays selected when components share a changed path', () => {
  const path = 'shared.txt'
  const first = { path, kind: 'added' },
    second = { path, kind: 'modified' }
  const files = [
    { componentId: 'first', path },
    { componentId: 'second', path },
  ]
  const reader = {
    data: { review: { changes: { first: [first], second: [second] } } },
    files,
    groups: [],
    source: { path: '/repo' },
    base: 'main',
  } as unknown as ReturnType<typeof useSimpleData>
  const scopeKey = simpleKey('p', null)
  const view = SimpleDiff({ scopeKey, selection: { ...files[1], line: 1 }, reader })
  const diff = element(view, DiffView)!
  expect(diff.props).toMatchObject({ componentId: 'second', file: second, lineFocus: 1 })
  const nav = diff.props.nav as { position: number; step: (delta: -1 | 1) => void }
  expect(nav.position).toBe(1)
  nav.step(-1)
  expect(useSimpleUi.getState().worktrees[scopeKey].diff).toEqual(files[0])
})
