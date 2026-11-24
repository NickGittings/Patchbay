const hooks = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as import('react').EffectCallback[],
  runAgents: [] as string[],
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.states))
      hooks.states[index] = typeof initial === 'function' ? initial() : initial
    return [
      hooks.states[index],
      (value: unknown) => {
        hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value
      },
    ]
  },
  useEffect: (effect: import('react').EffectCallback) => {
    hooks.effects.push(effect)
  },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  getCurrentWebviewWindow: () => ({ label: 'main' }),
}))
vi.mock('../../store', async (original) => {
  const store = await original<typeof import('../../store')>()
  return {
    ...store,
    // Read the live store when simulating client renders with the static renderer.
    useStore: Object.assign(
      <T>(select: (state: ReturnType<typeof store.useStore.getState>) => T) =>
        select(store.useStore.getState()),
      store.useStore,
    ),
  }
})
vi.mock('../../lib/auto', async () => ({
  ...(await vi.importActual('../../lib/autoSettings')),
  runAgents: () => hooks.runAgents,
  AutoHooksRequired: class extends Error {},
  autoSnapshot: vi.fn(),
  checkAutoHooks: vi.fn(),
  inferStage: vi.fn(),
  IN_PLACE_MERGE: { mode: 'ask', destinationBranch: '' },
  reviewBaseMoved: vi.fn(),
  startAuto: vi.fn(),
}))
vi.mock('../../lib/autoWorktree', () => ({ seedAutoTask: vi.fn() }))
vi.mock('../../lib/stories', () => ({ linkAutoStory: vi.fn() }))
vi.mock('../../lib/simpleActions', () => ({ logSimple: vi.fn() }))
import { beforeEach, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AutoDialog from './AutoDialog'
import { useStore } from '../../store'
import { autoDraftKey, autoDrafts, emptyAutoDraft } from '../../lib/autoDrafts'
import { autoSnapshot, inferStage } from '../../lib/auto'

beforeEach(() => {
  hooks.cursor = 0
  hooks.states = []
  hooks.effects = []
  vi.resetAllMocks()
  useStore.setState(useStore.getInitialState())
  useStore.setState({
    devices: [
      {
        id: 'codex',
        name: 'Codex',
        command: 'codex',
        kind: 'agent',
        source: 'builtin',
        category: 'agent',
      },
    ],
  })
  autoDrafts.clear()
})

test('Auto defaults to unchecked main from the project folder on a feature branch', async () => {
  useStore.getState().loadProject({
    projectId: 'p',
    root: '/p',
    name: 'Project',
    schemaVersion: 4,
    components: [],
    links: [],
  })
  const key = autoDraftKey('p', null)
  const simpleDraft = { ...emptyAutoDraft(), effort: 'light', destination: 'deleted-branch' }
  autoDrafts.set(key, simpleDraft)
  const source = { path: '/p', branch: 'feature', head: 'abc', current: true, main: true }
  vi.mocked(autoSnapshot).mockResolvedValue({
    source,
    worktrees: [source],
    branches: ['feature', 'main', 'release'],
    base: 'main',
    goal: 'Finish the feature',
    plan: '',
    planMark: '',
    proposal: false,
    changedComponents: [],
    hasChanges: true,
    findings: null,
    freshness: 'none',
    outcome: 'notMerged',
    agents: [],
    inPlace: false,
    baseInputs: '',
  })
  vi.mocked(inferStage).mockReturnValue({ stage: 'review', status: 'running', reason: 'Review' })
  const render = () => {
    hooks.cursor = 0
    hooks.effects = []
    return renderToStaticMarkup(createElement(AutoDialog, { onIntegrations: () => {} }))
  }
  // The second snapshot uses the destination filled in by the first.
  for (let i = 0; i < 2; i++) {
    render()
    const cleanups = hooks.effects.map((effect) => effect())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    cleanups.forEach((cleanup) => cleanup?.())
  }
  const html = render()
  expect(autoDrafts.get(key)?.destination).toBeUndefined()
  expect(html).toContain('<option value="main" selected="">main (creates worktree)</option>')
  expect(html).toContain('<option value="release">release (creates worktree)</option>')
  expect(html).not.toContain('<option value="feature"')
  expect(html).toContain('<button class="primary auto-start">Start</button>')
  expect(inferStage).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ effort: 'standard' }),
    true,
  )
  expect(html).toContain(
    '<input type="checkbox" role="switch" checked=""/>Validate after implementation and fixes',
  )
})

test.each([false, true])(
  'Full/Simple launch controls default both independent toggles off (simple=%s)',
  (simple) => {
    const html = renderToStaticMarkup(
      createElement(AutoDialog, { simple, onIntegrations: () => {} }),
    )
    expect(html).toContain('Autonomous execution')
    expect(html).toContain('Merge automatically after review')
    expect(html).toContain('<input type="checkbox" role="switch"/>Autonomous execution')
    expect(html).toContain('<input type="checkbox" role="switch"/>Merge automatically after review')
  },
)

test.each([false, true])(
  'Full/Simple launch controls preserve automatic merge and autonomous preferences independently (simple=%s)',
  (simple) => {
    for (const autonomous of [false, true]) {
      autoDrafts.set(autoDraftKey(undefined, null), {
        ...emptyAutoDraft(),
        autonomous,
        mode: 'auto',
      })
      const html = renderToStaticMarkup(
        createElement(AutoDialog, { simple, onIntegrations: () => {} }),
      )
      expect(html).toMatch(
        /<input type="checkbox" role="switch" checked=""\/>Merge automatically after review/,
      )
      expect(html).not.toMatch(/<input type="checkbox" disabled=""[^>]*\/>Merge automatically/)
      expect(html).toContain(
        autonomous
          ? '<input type="checkbox" role="switch" checked=""/>Autonomous execution'
          : '<input type="checkbox" role="switch"/>Autonomous execution',
      )
    }
  },
)
