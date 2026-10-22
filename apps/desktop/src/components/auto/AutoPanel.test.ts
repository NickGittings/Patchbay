import { beforeEach, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { ReviewFindings } from '../../types'
import AutoPanel from './AutoPanel'

type Snapshot = ReturnType<typeof import('../../store').useStore.getState>
const mock = vi.hoisted(() => ({ state: {} as Snapshot, findings: null as ReviewFindings | null }))
vi.mock('../../store', () => ({
  useStore: (select: (s: Snapshot) => unknown) => select(mock.state),
}))
vi.mock('../../lib/auto', () => ({
  STAGE_LABELS: { review: 'Review' },
  effortSettings: () => ({ maxRounds: 2 }),
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

beforeEach(() => {
  mock.state = {
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
