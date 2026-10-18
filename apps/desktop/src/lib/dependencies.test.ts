import { expect, test, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  mapLinksRead: vi.fn<(projectId: string) => Promise<unknown>>(async () => null),
  mapLinksClear: vi.fn<(projectId: string, id: string) => Promise<boolean>>(async () => true),
}))
vi.mock('../store', () => ({
  useStore: { getState: () => ({ project: { id: 'a' } }), subscribe: () => () => {} },
  projectStateOf: (id: string) => (['a', 'b'].includes(id) ? {} : undefined),
}))
vi.mock('./ipc', () => ipc)
vi.mock('./mapSave', () => ({}))
vi.mock('./attention', () => ({}))
vi.mock('./sessions', () => ({}))
const {
  closeDependencies,
  discardDependencies,
  newLinks,
  offerDependencies,
  shouldOfferDetection,
  unlinked,
  useDependencies,
} = await import('./dependencies')

const project = {
  components: [{ id: 'app' }, { id: 'api' }, { id: 'jobs' }],
  links: [{ id: 'app->api', source: 'jobs', target: 'api', label: 'Django' }],
}

test('new links drop unknown ends, self links and pairs already linked in any label', () => {
  const links = newLinks(project, [
    { source: 'app', target: 'api', label: ' REST ', reason: 'App/API.swift:3', detector: 'agent' },
    { source: 'app', target: 'api', label: 'again', detector: 'agent' },
    { source: 'jobs', target: 'api', label: 'other label', detector: 'builtin' },
    { source: 'app', target: 'gone', detector: 'agent' },
    { source: 'api', target: 'api', detector: 'agent' },
    { source: 'api', target: 'jobs', label: '', detector: 'builtin' },
  ])
  expect(links).toEqual([
    // The id detection would give is taken by a link between other components.
    {
      detection: { detector: 'agent' },
      id: 'app->api-2',
      source: 'app',
      target: 'api',
      label: 'REST',
    },
    {
      detection: { detector: 'builtin' },
      id: 'api->jobs',
      source: 'api',
      target: 'jobs',
      label: null,
    },
  ])
})

test('detection is offered while two or more components include an unlinked one', () => {
  expect(unlinked(project).map((c) => c.id)).toEqual(['app'])
  expect(shouldOfferDetection(project as never, false)).toBe(true)
  const linked = {
    ...project,
    links: [...project.links, { id: 'x', source: 'app', target: 'api' }],
  }
  expect(shouldOfferDetection(linked as never, false)).toBe(false)
})

test('detection is offered for unlinked maps of two or more components until declined', () => {
  expect(shouldOfferDetection({ components: project.components as never, links: [] }, false)).toBe(
    true,
  )
  expect(shouldOfferDetection({ components: project.components as never, links: [] }, true)).toBe(
    false,
  )
  expect(shouldOfferDetection({ components: [{ id: 'one' }] as never, links: [] }, false)).toBe(
    false,
  )
})

const pending = (id: string) => ({ id, sessionId: 's', submittedMs: 1, links: [], skipped: [] })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("a project's dialog never blocks another project's", async () => {
  useDependencies.setState({ dialogs: {}, busy: {} })
  offerDependencies('b')
  await settle()
  offerDependencies('a')
  await settle()
  const { dialogs } = useDependencies.getState()
  expect(dialogs.a?.mode).toBe('offer')
  expect(dialogs.b?.mode).toBe('offer')
  closeDependencies('b')
  await settle()
  expect(Object.keys(useDependencies.getState().dialogs)).toEqual(['a'])
})

test('a discarded submission is cleared before the review closes, and stale reads keep it closed', async () => {
  useDependencies.setState({ dialogs: {}, busy: {} })
  ipc.mapLinksRead.mockResolvedValue(pending('one'))
  offerDependencies('a')
  await settle()
  expect(useDependencies.getState().dialogs.a?.mode).toBe('review')
  let finish = (_: boolean) => {}
  ipc.mapLinksClear.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const discarded = discardDependencies('a')
  // Still open, and waiting, until the backend has forgotten it.
  expect(useDependencies.getState().dialogs.a?.mode).toBe('review')
  expect(useDependencies.getState().busy.a).toBe(true)
  finish(true)
  await discarded
  expect(ipc.mapLinksClear).toHaveBeenCalledWith('a', 'one')
  // The read made after clearing still returned the old submission: it stays closed.
  expect(useDependencies.getState().dialogs.a).toBeUndefined()
  offerDependencies('a')
  await settle()
  expect(useDependencies.getState().dialogs.a?.mode).toBe('offer')
  ipc.mapLinksRead.mockResolvedValue(null)
})
