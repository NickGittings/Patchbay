import { expect, test, vi } from 'vitest'

vi.mock('../store', () => ({ useStore: { getState: () => ({}), subscribe: () => () => {} } }))
vi.mock('./ipc', () => ({}))
vi.mock('./mapSave', () => ({}))
vi.mock('./attention', () => ({}))
vi.mock('./sessions', () => ({}))
const { newLinks, shouldOfferDetection, unlinked } = await import('./dependencies')

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
