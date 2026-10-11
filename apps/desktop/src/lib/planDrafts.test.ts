import { beforeEach, expect, test, vi } from 'vitest'

vi.mock('./ipc', () => ({ planWrite: vi.fn() }))
const { planWrite } = await import('./ipc')
const { planDrafts, savePlanDraft } = await import('./planDrafts')

beforeEach(() => {
  planDrafts.clear()
  vi.mocked(planWrite).mockReset()
})

test('implementation saves the draft for its launch project and task', async () => {
  planDrafts.set('one\nt1', { text: 'edited', base: 'saved', overwrite: false })
  planDrafts.set('two\nt1', { text: 'other project', base: '', overwrite: false })
  vi.mocked(planWrite).mockResolvedValue(true)
  await savePlanDraft('one', 't1')
  expect(planWrite).toHaveBeenCalledWith('one', 't1', 'edited', 'saved')
  expect(planDrafts.has('one\nt1')).toBe(false)
  expect(planDrafts.has('two\nt1')).toBe(true)
})

test('a changed saved plan blocks launch and keeps edits for review', async () => {
  const draft = { text: 'edited', base: 'saved', overwrite: true }
  planDrafts.set('one\n', draft)
  vi.mocked(planWrite).mockResolvedValue(false)
  await expect(savePlanDraft('one', null)).rejects.toThrow('Review and save your edits')
  expect(planWrite).toHaveBeenCalledWith('one', undefined, 'edited', 'saved')
  expect(planDrafts.get('one\n')).toBe(draft)
})

test('concurrent launches wait for edits made during the save', async () => {
  planDrafts.set('one\nt1', { text: 'first edit', base: 'saved', overwrite: false })
  let finish!: (saved: boolean) => void
  vi.mocked(planWrite).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  vi.mocked(planWrite).mockResolvedValueOnce(true)
  const first = savePlanDraft('one', 't1')
  expect(savePlanDraft('one', 't1')).toBe(first)
  planDrafts.set('one\nt1', { text: 'second edit', base: 'saved', overwrite: false })
  finish(true)
  await first
  expect(planWrite).toHaveBeenLastCalledWith('one', 't1', 'second edit', 'first edit')
  expect(planDrafts.size).toBe(0)
})
