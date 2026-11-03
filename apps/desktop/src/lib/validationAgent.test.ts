import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../store'
import type { PendingValidation } from '../types'
vi.mock('./ipc', () => ({
  validationProposalRead: vi.fn(async () => null),
  validationProposalClear: vi.fn(async () => true),
  onValidationProposals: vi.fn(async () => () => {}),
}))
vi.mock('./dependencies', () => ({ startDetectionAgent: vi.fn() }))
vi.mock('./mapSave', () => ({
  mapEditsBlocked: () => false,
  flushMapSaves: vi.fn(async () => true),
}))
vi.mock('./actions', () => ({ graphActionIn: vi.fn(async () => ({})) }))
const { applyValidationProposal, useValidationProposals } = await import('./validationAgent')
const { graphActionIn } = await import('./actions')
const pending: PendingValidation = {
  id: 'submission',
  sessionId: 'agent',
  submittedMs: 1,
  componentIds: ['api'],
  terminals: [
    {
      component: 'api',
      path: 'api',
      terminal: null,
      name: 'Tests',
      command: 'npm test',
      reason: 'package.json:7',
    },
  ],
  missing: [],
}
beforeEach(() => {
  vi.clearAllMocks()
  useStore.setState(useStore.getInitialState())
  useValidationProposals.setState({ pending: { p: pending }, busy: {} })
  useStore.getState().loadProject({
    projectId: 'p',
    schemaVersion: 4,
    root: '/p',
    name: 'P',
    links: [],
    components: [
      {
        id: 'api',
        name: 'API',
        kind: 'backend',
        notes: '',
        position: { x: 0, y: 0 },
        path: 'api',
        terminals: [
          { id: 'dev', name: 'Dev', kind: 'task', command: 'npm run dev', action: 'development' },
        ],
      },
    ],
  })
})
test('application preserves development terminals and deduplicates retries', async () => {
  await applyValidationProposal(pending, pending.terminals, 'p')
  await applyValidationProposal(pending, pending.terminals, 'p')
  const terminals = useStore.getState().nodes[0].data.terminals
  expect(terminals).toHaveLength(2)
  expect(terminals[0].action).toBe('development')
  expect(terminals[1].action).toBe('validation')
  expect(graphActionIn).not.toHaveBeenCalled()
})
test('stale folders and commands stay unapplied', async () => {
  useStore.getState().updateTerminal('api', 'dev', { action: undefined })
  await applyValidationProposal(
    pending,
    [{ ...pending.terminals[0], terminal: 'dev', name: null }],
    'p',
  )
  await applyValidationProposal(pending, [{ ...pending.terminals[0], path: 'old' }], 'p')
  expect(useStore.getState().nodes[0].data.terminals).toHaveLength(1)
  expect(useStore.getState().nodes[0].data.terminals[0].action).toBeUndefined()
})
test('apply and run uses the selected scope and captured worktree', async () => {
  await applyValidationProposal(pending, pending.terminals, 'p', true)
  expect(graphActionIn).toHaveBeenCalledWith(
    'p',
    null,
    expect.objectContaining({ projectId: 'p' }),
    { kind: 'validateSelected', componentIds: ['api'] },
  )
})
test('project switching and competing actions prevent applying and running', async () => {
  await applyValidationProposal(pending, pending.terminals, 'other', true)
  useStore.setState({ graphActionBusy: true })
  await applyValidationProposal(pending, pending.terminals, 'p', true)
  expect(graphActionIn).not.toHaveBeenCalled()
  expect(useStore.getState().nodes[0].data.terminals).toHaveLength(1)
})

test('saved proposals recover and clearing an old submission preserves a newer one', async () => {
  const { validationProposalRead, validationProposalClear } = await import('./ipc')
  const { refreshValidationProposal, discardValidationProposal } = await import('./validationAgent')
  useValidationProposals.setState({ pending: {} })
  const recovered = { ...pending, id: 'recovered-submission' }
  vi.mocked(validationProposalRead).mockResolvedValueOnce(recovered)
  await refreshValidationProposal('p')
  expect(useValidationProposals.getState().pending.p).toEqual(recovered)
  const newer = { ...pending, id: 'new-submission' }
  vi.mocked(validationProposalRead).mockResolvedValueOnce(newer)
  await discardValidationProposal('p', recovered.id)
  expect(validationProposalClear).toHaveBeenCalledWith('p', recovered.id)
  expect(useValidationProposals.getState().pending.p).toEqual(newer)
})
