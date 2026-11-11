import { beforeEach, expect, test, vi } from 'vitest'
import DiffView from './DiffView'
import { renderToStaticMarkup } from 'react-dom/server'

const h = vi.hoisted(() => ({
  project: 'p',
  states: [] as unknown[],
  cursor: 0,
  effects: [] as { deps: unknown[]; cleanup?: () => void }[],
  effectCursor: 0,
  query: vi.fn(),
  request: vi.fn(),
}))
vi.mock('../../store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ project: { id: h.project } }),
}))
vi.mock('../../lib/git', () => ({ componentPaths: () => [] }))
vi.mock('../../lib/history', () => ({ historyRequest: vi.fn() }))
vi.mock('../../lib/ipc', () => ({ gitDiff: h.request }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.states)) h.states[i] = initial
    return [h.states[i], (value: unknown) => (h.states[i] = value)]
  },
  useRef: () => ({ current: { querySelector: h.query } }),
  useMemo: (fn: () => unknown) => fn(),
  useEffect: (fn: () => (() => void) | undefined, deps: unknown[]) => {
    const i = h.effectCursor++
    const previous = h.effects[i]
    if (previous && deps.every((d, n) => d === previous.deps[n])) return
    previous?.cleanup?.()
    h.effects[i] = { deps, cleanup: fn() }
  },
}))
const file = { path: 'src/file', kind: 'modified' as const }
function render(base = 'main', worktree = '/task', lineFocus?: number) {
  h.cursor = 0
  h.effectCursor = 0
  return DiffView({ componentId: 'app', file, base, worktree, lineFocus, revision: 1 })
}
beforeEach(() => {
  h.effects.forEach((e) => e.cleanup?.())
  h.effects = []
  h.states = []
  h.project = 'p'
  vi.clearAllMocks()
})
test('passes the branch base and focuses the finding line after its diff arrives', async () => {
  const scrollIntoView = vi.fn()
  h.query.mockReturnValue({ scrollIntoView })
  h.request.mockResolvedValue({ patch: '@@ -1 +1 @@\n-old\n+new\n', binary: false })
  render('main', '/task', 12)
  await Promise.resolve()
  render('main', '/task', 12)
  expect(h.request).toHaveBeenCalledWith([], 'app', 'src/file', undefined, '/task', 'main')
  expect(h.query).toHaveBeenCalledWith('[data-new-line="12"]')
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
})
test('deleted finding lines expose old line coordinates and can be focused', async () => {
  const scrollIntoView = vi.fn()
  h.query.mockImplementation((selector: string) =>
    selector === '[data-old-line="12"]' ? { scrollIntoView } : null,
  )
  h.request.mockResolvedValue({ patch: '@@ -12 +11,0 @@\n-removed\n', binary: false })
  render('main', '/task', 12)
  await Promise.resolve()
  const markup = renderToStaticMarkup(render('main', '/task', 12))
  expect(markup).toContain('data-old-line="12"')
  expect(h.query).toHaveBeenCalledWith('[data-old-line="12"]')
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' })
})
test.each(['base', 'worktree', 'project'])(
  'drops a late response after changing %s',
  async (scope) => {
    let finish!: (value: unknown) => void
    h.request.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
    render()
    h.request.mockReturnValue(new Promise(() => {}))
    if (scope === 'project') h.project = 'other'
    render(scope === 'base' ? 'release' : 'main', scope === 'worktree' ? '/other' : '/task')
    finish({ patch: 'stale', binary: false })
    await Promise.resolve()
    expect(h.states[0]).toBeNull()
  },
)
