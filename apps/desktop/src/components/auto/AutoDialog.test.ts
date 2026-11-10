vi.mock('../../lib/auto', async () => ({
  ...(await vi.importActual('../../lib/autoSettings')),
  runAgents: () => [],
  AutoHooksRequired: class extends Error {},
  NoReviewBase: class extends Error {},
  autoSnapshot: vi.fn(),
  checkAutoHooks: vi.fn(),
  inferStage: vi.fn(),
  reviewBaseMoved: vi.fn(),
  startAuto: vi.fn(),
  wantsNewWorktree: vi.fn(),
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

beforeEach(() => {
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

test.each([false, true])(
  'Full/Simple launch controls default both independent toggles off (simple=%s)',
  (simple) => {
    const html = renderToStaticMarkup(
      createElement(AutoDialog, { simple, onIntegrations: () => {} }),
    )
    expect(html).toContain('Autonomous execution')
    expect(html).toContain('Merge automatically after review')
    expect(html).toContain('<input type="checkbox"/>Autonomous execution')
    expect(html).toContain('<input type="checkbox"/>Merge automatically after review')
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
      expect(html).toMatch(/<input type="checkbox" checked=""\/>Merge automatically after review/)
      expect(html).not.toMatch(/<input type="checkbox" disabled=""[^>]*\/>Merge automatically/)
      expect(html).toContain(
        autonomous
          ? '<input type="checkbox" checked=""/>Autonomous execution'
          : '<input type="checkbox"/>Autonomous execution',
      )
    }
  },
)
