import { describe, expect, test } from 'vitest'
import type { AgentReport, SessionState, SessionStatus, TerminalKind } from '../types'
import { describeTerminal, paneAutoStarts, sessionRun, terminalStatus } from './display'

const NOW = 1_000_000
const status = (patch: Partial<SessionStatus> = {}): SessionStatus => ({
  lastOutputMs: null,
  active: false,
  agent: null,
  url: null,
  ready: false,
  healthy: null,
  stopped: false,
  seenMs: null,
  ...patch,
})
const agent = (state: AgentReport['state'], sinceMs = NOW - 60_000): AgentReport => ({
  state,
  sinceMs,
  message: null,
  prompt: 'fix the build',
})
const running = (patch: Partial<SessionStatus> = {}): SessionState => ({
  running: true,
  status: status(patch),
})
const exited = (exitCode: number, patch: Partial<SessionStatus> = {}): SessionState => ({
  running: false,
  exitCode,
  exitedMs: NOW - 5_000,
  status: status(patch),
})

describe('terminalStatus', () => {
  test('sessions that never ran or lost the service ask for nothing', () => {
    expect(terminalStatus('task', undefined, NOW)).toMatchObject({ label: 'Not started' })
    expect(terminalStatus('task', { running: true, disconnected: true }, NOW)).toMatchObject({
      label: 'Disconnected',
      attention: 0,
    })
  })

  test('an interrupted session explains how to recover after a service restart', () => {
    expect(terminalStatus('agent', { running: false, interrupted: true }, NOW)).toMatchObject({
      health: 'fail',
      label: 'Interrupted',
      detail: 'The session service restarted. Choose Resume in Sessions or Restart to recover.',
      attention: 1,
    })
  })

  test('a failure asks for attention until a window has shown it', () => {
    expect(terminalStatus('task', exited(2), NOW)).toMatchObject({
      health: 'fail',
      detail: 'Exited 2 — 5s ago',
      attention: 3,
      unseenSince: NOW - 5_000,
    })
    expect(terminalStatus('task', exited(2, { seenMs: NOW }), NOW)).toMatchObject({
      health: 'fail',
      attention: 0,
      unseenSince: undefined,
    })
    // An interactive shell's exit code is the user's business.
    expect(terminalStatus('shell', exited(1), NOW).attention).toBe(0)
  })

  test('a stop or a clean exit is not a failure', () => {
    expect(terminalStatus('task', exited(137, { stopped: true }), NOW)).toMatchObject({
      health: 'idle',
      label: 'Stopped',
    })
    expect(terminalStatus('task', exited(0), NOW)).toMatchObject({ health: 'ok', attention: 0 })
  })

  test('agent reports rank needs input above a review', () => {
    expect(terminalStatus('agent', running({ agent: agent('needsInput') }), NOW)).toMatchObject({
      health: 'input',
      attention: 4,
      detail: 'Waiting for your answer — for 1m',
      unseenSince: NOW - 60_000,
    })
    expect(terminalStatus('agent', running({ agent: agent('review') }), NOW)).toMatchObject({
      health: 'review',
      attention: 2,
      unseenSince: NOW - 60_000,
    })
    expect(terminalStatus('agent', running({ agent: agent('working') }), NOW)).toMatchObject({
      label: 'Working',
      attention: 0,
    })
  })

  test('input requests stay in attention after acknowledgement without remaining unseen', () => {
    expect(
      terminalStatus('agent', running({ agent: agent('needsInput'), seenMs: NOW }), NOW),
    ).toMatchObject({
      health: 'input',
      attention: 4,
      unseenSince: undefined,
    })
  })

  test('a seen review goes back to waiting', () => {
    const seen = running({ agent: agent('review'), seenMs: NOW })
    expect(terminalStatus('agent', seen, NOW)).toMatchObject({ label: 'Waiting', attention: 0 })
  })

  test('agents without reports are judged by output', () => {
    expect(terminalStatus('agent', running({ active: true }), NOW).label).toBe('Active')
    expect(terminalStatus('agent', running({ lastOutputMs: NOW - 120_000 }), NOW)).toMatchObject({
      label: 'Quiet',
      detail: 'No output for 2m',
    })
  })

  test('services report readiness and health', () => {
    const url = 'http://localhost:3000'
    expect(terminalStatus('task', running({ url, ready: true }), NOW)).toMatchObject({
      health: 'ready',
      url,
    })
    expect(terminalStatus('task', running({ url, healthy: false }), NOW)).toMatchObject({
      health: 'unhealthy',
      attention: 3,
    })
    expect(terminalStatus('shell', running(), NOW).label).toBe('Open')
    expect(terminalStatus('task', running(), NOW).label).toBe('Running')
  })
})

test('describeTerminal names interactive shells', () => {
  expect(describeTerminal({ id: 's', name: 'Shell', command: '', kind: 'shell' })).toBe(
    'interactive shell',
  )
  expect(describeTerminal({ id: 't', name: 'Test', command: 'npm test', kind: 'task' })).toBe(
    'npm test',
  )
})

test('sessionRun tells apart runs that reuse a generation after a service restart', () => {
  const run = sessionRun('sid', { generation: 3, startedMs: 10 })
  expect(sessionRun('sid', { generation: 3, startedMs: 10 })).toBe(run)
  expect(sessionRun('sid', { generation: 3, startedMs: 20 })).not.toBe(run)
  expect(sessionRun('sid', { generation: 4, startedMs: 10 })).not.toBe(run)
  expect(sessionRun('other', { generation: 3, startedMs: 10 })).not.toBe(run)
})

// Review and merge panes must never bypass the launch that records their attempt and findings.
test.each<[string, TerminalKind, boolean]>([
  ['component', 'shell', true],
  ['component', 'task', false],
  ['component', 'agent', false],
  ['@task', 'shell', false],
  ['@task', 'task', false],
  ['@task', 'agent', false],
  ['@plan', 'agent', false],
  ['@review', 'agent', false],
  ['@merge', 'agent', false],
  ['@review', 'shell', false],
  ['@merge', 'shell', false],
])('pane auto-start for %s %s is %s', (scope, kind, expected) => {
  expect(paneAutoStarts(scope, { id: 'terminal', name: 'Terminal', kind, command: '' })).toBe(
    expected,
  )
})
