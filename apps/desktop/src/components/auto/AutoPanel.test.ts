import { beforeEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ReviewFindings } from '../../types'
import AutoPanel from './AutoPanel'

type Snapshot = ReturnType<typeof import('../../store').useStore.getState>
const mock = vi.hoisted(() => ({
  state: {} as Snapshot,
  findings: null as ReviewFindings | null,
  stage: null as null | { autoCurrent: boolean; stepper: unknown[] },
}))
vi.mock('../../store', () => ({
  useStore: (select: (s: Snapshot) => unknown) => select(mock.state),
}))
vi.mock('../../lib/auto', () => ({
  STAGE_LABELS: { review: 'Review' },
  effortSettings: () => ({ maxRounds: 2 }),
  inPlace: (run: { baseCommit?: string }) => !!run.baseCommit,
}))
vi.mock('../../lib/simpleActions', () => ({ logSimple: vi.fn() }))
vi.mock('../../lib/attention', () => ({ revealTerminal: vi.fn() }))
vi.mock('../../lib/tasks', () => ({ activeTaskOf: () => ({ branch: 'feature' }) }))
vi.mock('../../lib/useReviewFindings', () => ({
  useReviewFindings: () => ({ findings: mock.findings }),
}))
vi.mock('../../lib/reviewAgents', () => ({
  useRunningReviewLanes: () => 'reviewer',
  laneRunning: (running: string, lane: string) => running === lane,
}))
vi.mock('./AutoDialog', () => ({ default: () => null }))
vi.mock('../../lib/useStageModel', () => ({ useStageModel: () => mock.stage }))
vi.mock('../../lib/plan', () => ({ agentDevices: () => [] }))
vi.mock('../../lib/usage', () => ({ presetExhausted: () => [], useUsage: () => null }))

beforeEach(() => {
  mock.stage = null
  mock.state = {
    workspaceSettings: {},
    project: { id: 'p' },
    auto: {
      runId: 'run',
      status: 'running',
      stage: 'review',
      goal: 'Ship',
      effort: 'standard',
      branch: 'feature',
      round: 0,
      log: [],
      merge: { destinationBranch: 'main' },
    },
  } as unknown as Snapshot
})

test.each(['writing', 'unreadable', 'failed'])(
  'Auto keeps its findings link when the verdict is %s',
  (state) => {
    mock.findings = {
      verdict: null,
      text: 'Existing findings',
      reviewers: [
        {
          lane: 'reviewer',
          finished: state === 'unreadable',
          error: state === 'writing' ? null : 'No readable verdict',
        },
      ],
    } as ReviewFindings
    const html = renderToStaticMarkup(createElement(AutoPanel, { onIntegrations: () => {} }))
    expect(html).toContain('Review:')
    expect(html).toContain('View findings')
    expect(html).toContain(state === 'writing' ? 'Reviewing…' : 'No verdict')
  },
)

test('Auto offers Review even when findings could not be loaded', () => {
  mock.findings = null
  const html = renderToStaticMarkup(createElement(AutoPanel, { onIntegrations: () => {} }))
  expect(html).toContain('No verdict')
  expect(html).toContain('View findings')
})

test('a scheduled paused run exposes its deadline and schedule controls in Simple mode', () => {
  mock.state.auto = {
    ...mock.state.auto!,
    status: 'paused',
    pauseKind: 'scheduled',
    resumeTrigger: { kind: 'time', atMs: 2000000000000 },
  }
  const html = renderToStaticMarkup(
    createElement(AutoPanel, { onIntegrations: () => {}, simple: true }),
  )
  expect(html).toContain('Cancel schedule')
  expect(html).toContain('Change schedule')
  expect(html).toContain('Resume now')
  expect(html).toContain('datetime-local')
  expect(html).toContain('Requires Patchbay open')
})

test('an attention pause cannot schedule around the issue', () => {
  mock.state.auto = { ...mock.state.auto!, status: 'paused', pauseKind: 'needsUser' }
  const html = renderToStaticMarkup(createElement(AutoPanel, { onIntegrations: () => {} }))
  expect(html).not.toContain('datetime-local')
})

test('the run panel exposes autonomous decisions and recovery attempts in Simple mode', () => {
  mock.state.auto = {
    ...mock.state.auto!,
    autonomous: true,
    recovery: { stage: 'review', attempts: 2, mark: 'm', reason: 'Missing review artifact' },
    log: [{ atMs: 1, text: 'Recovery 2/3: relaunch the stage' }],
  }
  const html = renderToStaticMarkup(
    createElement(AutoPanel, { onIntegrations: () => {}, simple: true }),
  )
  expect(html).toContain('Autonomous execution')
  expect(html).toContain('Recovery 2/3 without progress')
  expect(html).toContain('Missing review artifact')
  expect(html).toContain('relaunch the stage')
})

test('the run’s stages read as Chat’s, with fixing as a pass inside Review', () => {
  mock.state.auto = { ...mock.state.auto!, stage: 'fix' }
  const html = renderToStaticMarkup(createElement(AutoPanel, { onIntegrations: () => {} }))
  expect(html).toContain('aria-label="Run stages"')
  expect(html).toMatch(/data-state="current"[^>]*><span>Review<small> · Fixing/)
  expect(html).not.toContain('Implement')
})

test('a finished run that later work superseded shows that work’s stages', () => {
  mock.state.auto = { ...mock.state.auto!, status: 'done', stage: 'done' }
  mock.stage = {
    autoCurrent: false,
    stepper: [
      { stage: 'plan', state: 'done' },
      { stage: 'build', state: 'done' },
      { stage: 'review', state: 'current' },
      { stage: 'merge', state: 'upcoming' },
    ],
  }
  const html = renderToStaticMarkup(createElement(AutoPanel, { onIntegrations: () => {} }))
  expect(html).toContain('aria-label="Current work stages"')
  expect(html).toContain('Work continued after this run')
  expect(html).toMatch(/data-state="current"[^>]*><span>Review/)
})
