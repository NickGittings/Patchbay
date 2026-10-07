// Task smoke test, run against the scratch repo smoke/tasks-fixture.sh creates: a task gets its
// own branch and worktree, the same terminal runs in the open worktree and the task's at once,
// Git badges, review and attention follow the active task, and a dirty worktree isn't removed.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const click = (el) => {
    if (!el) throw new Error('missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const edit = (el, value) => {
    if (!el) throw new Error('missing input target')
    const prototype =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const button = (root, name) =>
    Array.from(root?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === name)
  // Plan and Implementation carry the picker in their headers, Navigation and Review in the toolbar.
  const pickerHost = () =>
    ({ implementation: '.implementation-header', plan: '.plan-scope' })[state().view] ?? '.toolbar'
  // Retries while closed: a view that just mounted may take focus, which closes the popover.
  const openPicker = () =>
    until(`worktree overview in ${state().view}`, () => {
      const trigger = document.querySelector(`${pickerHost()} .worktree-picker .menu-trigger`)
      if (trigger?.getAttribute('aria-expanded') === 'true')
        return document.querySelector('.worktree-popover')
      if (trigger) click(trigger)
      return null
    })
  const viewButton = (name) =>
    Array.from(document.querySelectorAll('.view-switcher button')).find(
      (b) => b.textContent === name,
    )
  // Without whitespace, since long paths wrap across terminal rows.
  const textOf = (sid) => smoke.terminalText(sid).text.replace(/\s+/g, '')
  let task
  try {
    const opened = await smoke.openProject()
    if (!opened) throw new Error('project was not opened')
    state().loadProject({
      ...opened.project,
      components: [
        {
          id: 'web',
          name: 'Web',
          kind: 'frontend',
          path: 'apps/web',
          notes: '',
          position: { x: 0, y: 0 },
          terminals: [
            {
              id: 'where',
              name: 'Where',
              command: 'printf "cwd:%s\\n" "$PWD"; exec cat',
              kind: 'task',
            },
            { id: 'shell', name: 'Shell', command: '', kind: 'shell' },
          ],
        },
        {
          id: 'docs',
          name: 'Docs',
          kind: 'library',
          path: '.',
          notes: '',
          position: { x: 300, y: 0 },
          terminals: [],
        },
      ],
      links: [],
    })
    await smoke.syncCurrentRoots()
    await smoke.refreshTasks()
    assert(state().tasks.length === 0, 'a fresh repo has tasks')

    // Start work from Plan, carrying both highlighted components into the dialog.
    click(viewButton('Plan'))
    state().toggleHighlight('web')
    state().toggleHighlight('docs')
    click(
      await until('New worktree', () =>
        button(document.querySelector('.plan-scope'), 'New worktree…'),
      ),
    )
    const dialog = await until('New worktree dialog', () =>
      document.querySelector('[aria-label="New worktree"]'),
    )
    assert(
      dialog.querySelectorAll('.chip.active').length === 2,
      'worktree lost highlighted components',
    )
    assert(dialog.textContent.includes("What's it for"), 'worktree purpose label missing')
    edit(dialog.querySelector('input'), 'Smoke task')
    await until(
      'branch from purpose',
      () => dialog.querySelectorAll('input')[1].value === 'smoke-task',
    )
    edit(dialog.querySelectorAll('input')[1], 'smoke/task')
    click(
      await until('Create worktree button', () => {
        const create = button(dialog, 'Create worktree')
        return create && !create.disabled && create
      }),
    )
    task = await until('created worktree', () =>
      state().tasks.find((t) => t.branch === 'smoke/task'),
    )
    await until('creation dialog closed', () => !document.querySelector('.task-dialog'))
    assert(task.components.length === 2, 'worktree scope was not saved')
    assert(task.branch === 'smoke/task' && !task.missing, 'task has no branch')
    assert(/patchbay-smoke-tasks\/shop-smoke-task$/.test(task.worktree), task.worktree)
    assert(state().activeTask === task.id, 'a new task is not active')
    click(viewButton('Plan'))
    await until('worktree in the Plan picker', () =>
      document.querySelector('.plan-scope .worktree-picker')?.textContent.includes('Smoke task'),
    )

    // The same terminal, in both worktrees at once.
    const mainSid = smoke.sessionId('web', 'where', null)
    const taskSid = smoke.sessionId('web', 'where', task.id)
    await smoke.startTerminal('web', 'where', null)
    await smoke.startTerminal('web', 'where', task.id)
    await until('main cwd', () => textOf(mainSid).includes('cwd:'))
    await until('task cwd', () => textOf(taskSid).includes('cwd:'))
    assert(
      /cwd:\S*patchbay-smoke-tasks\/shop\/apps\/web/.test(textOf(mainSid)),
      `main terminal ran in ${textOf(mainSid)}`,
    )
    assert(
      /cwd:\S*shop-smoke-task\/apps\/web/.test(textOf(taskSid)),
      `task terminal ran in ${textOf(taskSid)}`,
    )
    assert(state().sessions[mainSid]?.running && state().sessions[taskSid]?.running, 'not both')

    // An edit in the task's worktree shows on the map only while the task is active.
    const shellSid = smoke.sessionId('web', 'shell', task.id)
    await smoke.startTerminal('web', 'shell', task.id)
    await until('task shell', () => state().sessions[shellSid]?.running)
    await sleep(1500)
    await smoke.terminalWrite(shellSid, 'printf x > smoke.txt\r')
    await smoke.requestGitRefresh()
    await until('task change badge', async () => {
      await smoke.requestGitRefresh()
      return state().gitChanges.web === 1
    })
    state().setActiveTask(null)
    await until('open worktree badge', async () => {
      await smoke.requestGitRefresh()
      return state().gitChanges.web === 0
    })
    state().setActiveTask(task.id)

    // Review follows the active task, with its task terminals' status.
    click(viewButton('Review'))
    await until('task review', () =>
      document.querySelector('.review-banner')?.textContent.includes('Smoke task'),
    )
    await until('task validation', () =>
      document.querySelector('.review-view .validation-chip.running'),
    )

    // Navigation's toolbar picker returns to the project folder; switching never stops sessions.
    click(viewButton('Navigation'))
    const navOverview = await openPicker()
    const taskRow = await until('Navigation task row', () =>
      navOverview.querySelector('.worktree-row.active'),
    )
    // Only the row's switch button switches, so selecting the path text doesn't.
    click(taskRow.querySelector('.worktree-path'))
    await sleep(100)
    assert(
      state().activeTask === task.id && document.querySelector('.worktree-popover'),
      'clicking the worktree path switched or closed the picker',
    )
    click(navOverview.querySelector('.worktree-row:not(.active) .worktree-row-switch'))
    await until(
      'project folder active',
      () => state().activeTask === null && !document.querySelector('.worktree-popover'),
    )
    click(viewButton('Plan'))
    const overview = await openPicker()
    const projectRow = await until('Project folder branch', () => {
      const row = overview.querySelector('.worktree-row.active')
      return row?.textContent.includes('main') && row
    })
    assert(projectRow.textContent.includes('Project folder'), 'project folder label missing')
    click(overview.querySelector('.worktree-row:not(.active) .worktree-row-switch'))
    await until(
      'worktree selected',
      () => state().activeTask === task.id && !document.querySelector('.worktree-popover'),
    )
    assert(
      state().sessions[mainSid]?.running && state().sessions[taskSid]?.running,
      'switching stopped terminals',
    )
    assert(!viewButton('Tasks'), 'Tasks view still exists')

    // The Plan picker lists both scopes and the worktree's changes.
    click(viewButton('Plan'))
    await openPicker()
    await until('worktree rows', () => document.querySelectorAll('.worktree-row').length === 2)
    await until('active worktree changes', () =>
      document.querySelector('.worktree-row.active')?.textContent.includes('±1'),
    )
    const activeRow = document.querySelector('.worktree-row.active')
    assert(activeRow.textContent.includes('2 running'), 'worktree running count missing')
    const bounds = document.querySelector('.worktree-popover').getBoundingClientRect()
    assert(
      bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      'picker outside viewport',
    )
    const notes = activeRow.querySelector('.worktree-notes-detail')
    assert(!notes.open, 'notes are not collapsed')
    click(notes.querySelector('summary'))
    edit(notes.querySelector('textarea'), 'smoke worktree notes')
    // Closing before the debounce expires must still save the edit.
    click(document.querySelector('.worktree-picker .menu-trigger'))
    await until(
      'notes saved on close',
      () => state().tasks.find((t) => t.id === task.id)?.notes === 'smoke worktree notes',
    )
    click(viewButton('Implementation'))
    await openPicker()
    await until('Implementation worktree notes', () =>
      document.querySelector('.worktree-row.active')?.textContent.includes('smoke worktree notes'),
    )
    click(button(document.querySelector('.worktree-row.active'), 'Review'))
    await until(
      'Review action',
      () =>
        state().view === 'review' &&
        document.querySelector('.review-banner')?.textContent.includes('Viewing worktree'),
    )

    // A plan saved in Plan reaches the task's component agents.
    state().updateComponent('web', {
      terminals: [
        ...state().nodes.find((n) => n.id === 'web').data.terminals,
        {
          id: 'brief',
          name: 'Brief',
          kind: 'agent',
          command: 'cat "$PATCHBAY_CONTEXT_FILE"; exec cat',
        },
      ],
    })
    click(viewButton('Plan'))
    click(await until('saved plan', () => document.querySelector('.plan-file summary')))
    const editor = await until('plan editor', () => {
      const el = document.querySelector('.plan-file textarea')
      return el && !el.disabled && el
    })
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      editor,
      'smoke-plan-step-one',
    )
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const save = await until('plan save', () =>
      Array.from(document.querySelectorAll('.plan-file button')).find(
        (b) => b.textContent === 'Save' && !b.disabled,
      ),
    )
    click(save)
    await until('plan saved', () => save.disabled)
    const briefSid = smoke.sessionId('web', 'brief', task.id)
    await smoke.startTerminal('web', 'brief', task.id)
    await until(
      'plan in the agent briefing',
      () =>
        textOf(briefSid).includes('##Sharedplan') &&
        textOf(briefSid).includes('smoke-plan-step-one'),
    )

    // git refuses to remove a dirty worktree; the task stays.
    click(viewButton('Implementation'))
    await openPicker()
    click(button(document.querySelector('.worktree-row.active'), 'Remove…'))
    const confirm = await until('removal options', () =>
      document.querySelector('.worktree-confirm'),
    )
    assert(button(confirm, 'Forget only'), 'forget option missing')
    state().setMessage('')
    click(button(confirm, 'Remove worktree'))
    // git's own refusal, not a leftover message or a removal still in flight.
    await until('dirty worktree refusal', () =>
      /uncommitted or untracked changes/.test(state().message ?? ''),
    )
    await smoke.refreshTasks()
    assert(
      state().tasks.some((t) => t.id === task.id),
      'dirty worktree removed',
    )
    // A refused removal leaves the task's terminals running.
    assert(state().sessions[taskSid]?.running, 'a refused removal stopped task terminals')
    await smoke.terminalWrite(shellSid, 'rm smoke.txt\r')
    await sleep(800)
    click(button(document.querySelector('.worktree-confirm'), 'Remove worktree'))
    await until('worktree removed', () => !state().tasks.some((t) => t.id === task.id))
    // Removing stops the task's terminals, but not the open worktree's.
    await until('task terminals stopped', () => !state().sessions[taskSid]?.running)
    assert(state().sessions[mainSid]?.running, 'removing a task stopped the open worktree')
    assert(state().tasks.length === 0 && state().activeTask === null, 'task not removed')
    task = undefined
    await smoke.report(
      'PASS tasks: create, parallel worktree terminals, badges, review, plan handoff, remove',
    )
  } catch (e) {
    smoke.resetSessions(await smoke.terminalReset())
    if (task) await smoke.removeTask(task.id, false).catch(() => {})
    await smoke.report(`FAIL tasks: ${e?.message ?? e}`)
  }
})()
