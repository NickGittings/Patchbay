vi.mock('../lib/chatTeams', () => ({ refreshChatTeams: vi.fn() }))
import { expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FlowNode } from '../store'
import { StackReview } from './StackPanel'
import type { PendingStack } from '../types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('../lib/windows', () => ({ showsSession: vi.fn() }))
const state = vi.hoisted(() => ({ nodes: [] as FlowNode[], groups: [], projects: {} }))
vi.mock('../store', () => ({
  useStore: Object.assign((select: (s: typeof state) => unknown) => select(state), {
    getState: () => state,
  }),
}))

test('a new proposal matching a renamed terminal reviews the command and readiness replacement', () => {
  state.nodes = [
    {
      id: 'api',
      type: 'component',
      position: { x: 0, y: 0 },
      data: {
        name: 'API',
        path: '.',
        kind: 'backend',
        notes: '',
        terminals: [
          {
            id: 'dev',
            name: 'Local  server',
            kind: 'task',
            command: 'old command',
            readyWhen: 'old ready',
            action: 'development',
          },
        ],
      },
    },
  ]
  const pending: PendingStack = {
    id: 'proposal',
    sessionId: 'agent',
    submittedMs: 1,
    name: 'Local',
    orderedStartup: false,
    terminals: [
      {
        component: 'api',
        name: ' local server ',
        command: 'new command',
        readyWhen: '',
        reason: 'README:1',
      },
    ],
  }
  const html = renderToStaticMarkup(createElement(StackReview, { pending, projectId: 'p' }))
  expect(html).toContain('Local  server')
  expect(html).toContain('Changed')
  expect(html).toContain('Replaces: old command')
  expect(html).toContain('Previous readiness: old ready')
  expect(html).not.toContain('(new)')
})
