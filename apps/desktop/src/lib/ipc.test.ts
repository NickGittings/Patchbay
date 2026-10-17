import { beforeEach, expect, test, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { extraContext } from '../extensions/context'
import type { Kickoff, Project, TerminalSpec } from '../types'
import { taskRootStart } from './ipc'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../extensions/context', () => ({ extraContext: vi.fn(async () => []) }))

beforeEach(() => vi.clearAllMocks())

test('taskRootStart sends each kickoff field in its backend location only', async () => {
  const project: Project = {
    projectId: 'p',
    schemaVersion: 4,
    root: '/p',
    name: 'P',
    components: [],
    links: [],
  }
  const terminal: TerminalSpec = { id: 'agent', name: 'Agent', kind: 'agent', command: 'codex' }
  const cases: [Kickoff | undefined, unknown, string | undefined][] = [
    [undefined, undefined, undefined],
    [{ kind: 'implementPlan', subagents: 3 }, { kind: 'implementPlan', subagents: 3 }, undefined],
    [{ kind: 'fixFindings', reviewSession: 'review-1' }, { kind: 'fixFindings' }, 'review-1'],
    [{ kind: 'fixFindings' }, { kind: 'fixFindings' }, undefined],
  ]
  for (const [kickoff, wireKickoff, reviewSession] of cases) {
    await taskRootStart(project, [], terminal, undefined, 'request', kickoff)
    expect(invoke).toHaveBeenLastCalledWith('task_root_start', {
      projectId: 'p',
      project,
      componentIds: [],
      terminal,
      task: undefined,
      requestId: 'request',
      auto: undefined,
      resume: false,
      kickoff: wireKickoff,
      reviewSession,
      extraContext: [],
    })
  }
  expect(extraContext).toHaveBeenCalledTimes(cases.length)
})
