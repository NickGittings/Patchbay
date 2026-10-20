import { beforeEach, expect, test, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  mapLinksRead: vi.fn<(projectId: string) => Promise<unknown>>(async () => null),
  mapLinksClear: vi.fn<(projectId: string, id: string) => Promise<boolean>>(async () => true),
  detectLinks: vi.fn<(project: unknown) => Promise<unknown[]>>(async () => []),
  onMapLinks: vi.fn(async () => () => {}),
}))
const agents = vi.hoisted(() => ({
  launching: vi.fn(() => false),
  mapPresetId: vi.fn(),
  startMapAgent: vi.fn(async () => true),
}))
const created = vi.hoisted(() => ({ listener: (_id: string) => {} }))
const store = vi.hoisted(() => ({
  projects: {} as Record<string, import('../store').ProjectEntry>,
  appendToMap: vi.fn<(id: string, extend: (p: unknown) => unknown) => unknown>(() => null),
  setMessage: vi.fn(),
  runtimeTerminals: {} as Record<string, unknown>,
  addRuntimeTerminal: vi.fn((sid: string, t: unknown) => {
    store.runtimeTerminals = { ...store.runtimeTerminals, [sid]: t }
  }),
  listener: (_s: unknown, _prev: unknown) => {},
}))
vi.mock('../store', () => ({
  appendToMap: store.appendToMap,
  useStore: {
    getState: () => ({
      project: { id: 'a' },
      projects: store.projects,
      setMessage: store.setMessage,
      sessions: {},
      addRuntimeTerminal: store.addRuntimeTerminal,
      runtimeTerminals: store.runtimeTerminals,
    }),
    setState: (update: (s: { runtimeTerminals: Record<string, unknown> }) => object) =>
      Object.assign(store, update({ runtimeTerminals: store.runtimeTerminals })),
    subscribe: (listener: typeof store.listener) => {
      store.listener = listener
      return () => {}
    },
  },
  projectStateOf: (id: string) => (store.projects[id] ? {} : undefined),
  projectOf: (id: string) =>
    store.projects[id] ? { components: [{ id: 'app' }, { id: 'api' }], links: [] } : undefined,
}))
vi.mock('./ipc', () => ipc)
vi.mock('./mapSave', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mapSave')>()),
  onMapCreated: (listener: (id: string) => void) => {
    created.listener = listener
    return () => {}
  },
}))
vi.mock('./attention', () => ({ revealTerminal: vi.fn() }))
vi.mock('./sessions', () => agents)
const arranged = vi.hoisted(() => ({
  arrangeMap: vi.fn<(id: string) => unknown>(() => ({ app: { x: 0, y: 0 } })),
  undoArrange: vi.fn(() => ({ label: 'Undo layout', run: () => {} })),
}))
vi.mock('./arrange', () => arranged)
const {
  acceptDependencies,
  appendLinks,
  addDependencies,
  closeDependencies,
  discardDependencies,
  initializeDependencyDetection,
  newLinks,
  offerDependencies,
  scanDependencies,
  startDependencyAgent,
  shouldOfferDetection,
  unlinked,
  useDependencies,
} = await import('./dependencies')

beforeEach(() => {
  store.projects = Object.fromEntries(
    ['a', 'b'].map((id) => [id, { id } as import('../store').ProjectEntry]),
  )
  store.appendToMap.mockClear()
  store.setMessage.mockClear()
  ipc.mapLinksRead.mockResolvedValue(null)
  useDependencies.setState({ dialogs: {}, busy: {} })
})

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

test('accepting new links rearranges the map and offers Undo', async () => {
  arranged.arrangeMap.mockClear()
  store.appendToMap.mockImplementationOnce(
    (_id: string, extend: (p: unknown) => unknown) =>
      extend({ components: [{ id: 'app' }, { id: 'api' }], links: [] }) as never,
  )
  useDependencies.setState({
    dialogs: { a: { mode: 'review', projectId: 'a', links: [] } },
  })
  await acceptDependencies('a', [{ source: 'app', target: 'api', detector: 'builtin' }])
  expect(arranged.arrangeMap).toHaveBeenCalledWith('a')
  expect(store.setMessage).toHaveBeenCalledWith(
    'Added 1 dependency and rearranged the map',
    true,
    expect.objectContaining({ label: 'Undo layout' }),
  )
})

test('adding selected links before launching an agent also offers layout Undo', () => {
  store.appendToMap.mockImplementationOnce((_id, extend) =>
    extend({ components: [{ id: 'app' }, { id: 'api' }], links: [] }),
  )
  addDependencies('a', [{ source: 'app', target: 'api', detector: 'builtin' }])
  expect(store.setMessage).toHaveBeenCalledWith(
    'Added 1 dependency and rearranged the map',
    true,
    expect.objectContaining({ label: 'Undo layout' }),
  )
})

test('nothing added leaves the layout alone', async () => {
  arranged.arrangeMap.mockClear()
  useDependencies.setState({
    dialogs: { a: { mode: 'review', projectId: 'a', links: [] } },
  })
  await acceptDependencies('a', [{ source: 'app', target: 'api', detector: 'builtin' }])
  expect(arranged.arrangeMap).not.toHaveBeenCalled()
  expect(store.setMessage).toHaveBeenCalledWith('Nothing new to add', true, undefined)
})

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
  let finish: (value: boolean) => void = () => {}
  ipc.mapLinksClear.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const discarded = discardDependencies('a')
  // Still open, and waiting, until the backend has forgotten it.
  expect(useDependencies.getState().dialogs.a?.mode).toBe('review')
  expect(useDependencies.getState().busy.a).toBe(1)
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

test("the first save's scan keeps the project busy and fills an offer opened meanwhile", async () => {
  useDependencies.setState({ dialogs: {}, busy: {} })
  const stop = initializeDependencyDetection()
  let finish: (links: unknown[]) => void = () => {}
  ipc.detectLinks.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  created.listener('a')
  await settle()
  expect(useDependencies.getState().busy.a).toBe(1)
  // The menu's offer opens while the scan runs; its Scan button waits on the busy project.
  offerDependencies('a')
  await settle()
  expect(useDependencies.getState().dialogs.a).toEqual({
    mode: 'offer',
    projectId: 'a',
    scanned: false,
  })
  finish([{ source: 'app', target: 'api', label: null }])
  await settle()
  expect(useDependencies.getState().busy.a).toBeUndefined()
  expect(useDependencies.getState().dialogs.a).toEqual({
    mode: 'review',
    projectId: 'a',
    links: [{ source: 'app', target: 'api', label: null, detector: 'builtin' }],
  })
  closeDependencies('a')
  stop()
})

const proposedLink = {
  source: 'app',
  target: 'api',
  reason: 'web/src/api.ts:1',
  detector: 'agent' as const,
}

for (const blocked of [
  { conflict: {} },
  { mapSave: { status: 'conflict' } },
  { unavailable: 'Missing project folder' },
]) {
  test(`blocked maps defer proposals and refuse dependency edits: ${JSON.stringify(blocked)}`, async () => {
    const proposal = { ...pending(`blocked-${JSON.stringify(blocked)}`), links: [proposedLink] }
    ipc.mapLinksRead.mockResolvedValue(proposal)
    store.projects.a = { ...store.projects.a, ...blocked } as never
    offerDependencies('a')
    await scanDependencies('a')
    await startDependencyAgent('a', {} as never)
    await settle()
    expect(useDependencies.getState().dialogs.a).toBeUndefined()

    // An already-open review must also refuse an edit and keep its pending submission.
    const dialog = {
      mode: 'review' as const,
      projectId: 'a',
      links: [proposedLink],
      pending: proposal,
    }
    useDependencies.setState({ dialogs: { a: dialog } })
    ipc.mapLinksClear.mockClear()
    expect(appendLinks('a', [proposedLink])).toBe(0)
    await acceptDependencies('a', [proposedLink])
    expect(store.appendToMap).not.toHaveBeenCalled()
    expect(ipc.mapLinksClear).not.toHaveBeenCalled()
    expect(useDependencies.getState().dialogs.a).toBe(dialog)

    // Recovery makes that same proposal reviewable again.
    store.projects.a = { id: 'a' } as never
    useDependencies.setState({ dialogs: {} })
    offerDependencies('a')
    await settle()
    expect(useDependencies.getState().dialogs.a?.mode).toBe('review')
  })
}

test('a conflict arriving during a proposal read prevents the review from opening', async () => {
  let finish: (value: unknown) => void = () => {}
  ipc.mapLinksRead.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  offerDependencies('a')
  store.projects.a.mapSave = { status: 'conflict' }
  finish({ ...pending('conflict-during-read'), links: [proposedLink] })
  await settle()
  expect(useDependencies.getState().dialogs.a).toBeUndefined()
})

test('a conflict arriving during a manifest scan prevents the review from opening', async () => {
  let finish: (value: unknown[]) => void = () => {}
  ipc.detectLinks.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
  const scanning = scanDependencies('a')
  store.projects.a.mapSave = { status: 'conflict' }
  finish([proposedLink])
  await scanning
  expect(useDependencies.getState().dialogs.a).toBeUndefined()
})

test('a proposal deferred by a conflict is surfaced when recovery finishes', async () => {
  const stop = initializeDependencyDetection()
  ipc.mapLinksRead.mockResolvedValue({ ...pending('recovered'), links: [proposedLink] })
  store.projects.a.mapSave = { status: 'conflict' }
  store.listener({ projects: store.projects }, { projects: {} })
  await settle()
  expect(useDependencies.getState().dialogs.a).toBeUndefined()
  const previous = store.projects
  store.projects = { ...previous, a: { ...previous.a, mapSave: undefined } }
  store.listener({ projects: store.projects }, { projects: previous })
  await settle()
  expect(useDependencies.getState().dialogs.a?.mode).toBe('review')
  stop()
})

for (const found of [[], [{ source: 'app', target: 'api', label: null }]]) {
  test(`a completed manifest scan preserves an agent review (${found.length} links found)`, async () => {
    let finish: (value: unknown[]) => void = () => {}
    ipc.detectLinks.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const scanning = scanDependencies('a')
    ipc.mapLinksRead.mockResolvedValue({ ...pending('during-scan'), links: [proposedLink] })
    offerDependencies('a')
    await settle()
    const review = useDependencies.getState().dialogs.a
    expect(review?.mode === 'review' && review.pending?.id).toBe('during-scan')
    finish(found)
    await scanning
    expect(useDependencies.getState().dialogs.a).toBe(review)
    expect(useDependencies.getState().busy.a).toBeUndefined()
  })
}

test('starting a new agent from a manifest review does not open an older waiting submission', async () => {
  useDependencies.setState({
    dialogs: { a: { mode: 'review', projectId: 'a', links: [] } },
  })
  ipc.mapLinksRead.mockClear()
  ipc.mapLinksRead.mockResolvedValue({ ...pending('older-run'), links: [proposedLink] })
  await startDependencyAgent('a', {
    id: 'claude',
    name: 'Claude',
    kind: 'agent',
    command: 'claude',
  })
  await settle()
  expect(agents.startMapAgent).toHaveBeenCalledWith('a', expect.objectContaining({ id: 'claude' }))
  expect(useDependencies.getState().dialogs.a).toBeUndefined()
  expect(ipc.mapLinksRead).not.toHaveBeenCalled()
})

test('a detection launch that does not start gives the tab back to the earlier preset', async () => {
  const earlier = { terminal: { name: 'Detect dependencies · Claude' } }
  const { MAP_AGENT_TERMINAL, MAP_SCOPE, sessionId } = await import('../types')
  const sid = sessionId(MAP_SCOPE, MAP_AGENT_TERMINAL, null, 'a')
  store.runtimeTerminals = { [sid]: earlier }
  agents.startMapAgent.mockResolvedValueOnce(false)
  await startDependencyAgent('a', { id: 'codex', name: 'Codex', kind: 'agent', command: 'codex' })
  expect(store.runtimeTerminals[sid]).toBe(earlier)
  store.runtimeTerminals = {}
  agents.startMapAgent.mockRejectedValueOnce(new Error('disconnected'))
  await expect(
    startDependencyAgent('a', { id: 'codex', name: 'Codex', kind: 'agent', command: 'codex' }),
  ).rejects.toThrow('disconnected')
  expect(store.runtimeTerminals).toEqual({})
})
