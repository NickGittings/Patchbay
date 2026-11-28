import { describe, expect, it, test } from 'vitest'
import { leadThread } from './leadThread'
import type { TimelineItem } from './simple'

const agent = (id: string, sessionId: string, atMs: number): TimelineItem => ({
  kind: 'agent',
  id,
  atMs,
  sessionId,
  entries: [],
})
const line = (id: string, atMs: number): TimelineItem => ({
  kind: 'line',
  id,
  atMs,
  text: id,
})

describe('leadThread', () => {
  it('shows only the lead and tags work from the focused worktree with its name and branch', () => {
    const conversation = [agent('lead', 'L', 1), agent('planner', 'P', 2), line('here', 3)]
    const focus = [
      agent('builder', 'B', 4),
      line('building', 5),
      { kind: 'result', id: 'review', atMs: 6, result: 'review' } as TimelineItem,
    ]
    const { items, chips } = leadThread({
      conversation,
      focus,
      leads: new Set(['L']),
      focused: true,
      conversationLabel: 'Project folder · main',
      focusLabel: 'Login · feat/login',
    })
    expect(items.map((i) => i.id)).toEqual(['lead', 'here', 'focus:building', 'focus:review'])
    expect(chips.get('lead')).toBeUndefined()
    expect(chips.get('here')).toBe('Project folder · main')
    expect(chips.get('focus:review')).toBe('Login · feat/login')
  })

  it('adds the project folder’s own work once when it is the focus', () => {
    const conversation = [agent('lead', 'L', 1), line('here', 2)]
    const { items, chips } = leadThread({
      conversation,
      focus: conversation,
      leads: new Set(['L']),
      focused: false,
      conversationLabel: 'Project folder · main',
      focusLabel: 'Project folder · main',
    })
    expect(items.map((i) => i.id)).toEqual(['lead', 'here'])
    expect(chips.get('here')).toBe('Project folder · main')
  })
})

test('keeps an earlier worktree lead’s conversation readable while its worktree is in focus', () => {
  const { items, chips } = leadThread({
    conversation: [agent('lead', 'L', 1)],
    focus: [agent('old', 'W', 2), agent('builder', 'B', 3)],
    leads: new Set(['L']),
    earlierLeads: new Set(['W']),
    focused: true,
    conversationLabel: 'Project folder · main',
    focusLabel: 'Login · feat/login',
  })
  expect(items.map((i) => i.id)).toEqual(['lead', 'focus:old'])
  expect(chips.get('focus:old')).toBe('Login · feat/login')
})

test('the user’s messages stay even when an earlier lead received them', () => {
  const prompt = {
    kind: 'agent',
    id: 'old',
    atMs: 1,
    sessionId: 'L0',
    entries: [{ id: 'p', kind: 'prompt', atMs: 1, stage: 'plan', text: 'hi', mentions: [] }],
  } as TimelineItem
  const { items } = leadThread({
    conversation: [prompt, agent('lead', 'L', 2)],
    focus: [],
    leads: new Set(['L']),
    focused: false,
    conversationLabel: 'Project folder',
    focusLabel: 'Project folder',
  })
  expect(items.map((i) => i.id)).toEqual(['old', 'lead'])
})
