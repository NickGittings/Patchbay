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
      ],
      links: [],
    })
    await smoke.syncCurrentRoots()
    await smoke.refreshTasks()
    assert(state().tasks.length === 0, 'a fresh repo has tasks')

    task = await smoke.createTask({
      title: 'Smoke task',
      branch: 'smoke/task',
      components: ['web'],
    })
    assert(task.branch === 'smoke/task' && !task.missing, 'task has no branch')
    assert(/patchbay-smoke-tasks\/shop-smoke-task$/.test(task.worktree), task.worktree)
    assert(state().activeTask === task.id, 'a new task is not active')
    await until('task in the switcher', () =>
      Array.from(document.querySelectorAll('.task-select option')).some((o) =>
        o.textContent.includes('Smoke task'),
      ),
    )

    // The same terminal, in both worktrees at once.
    const mainSid = 'web/where'
    const taskSid = `web/where@task-${task.id}`
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
    const shellSid = `web/shell@task-${task.id}`
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

    // The Tasks view lists both scopes and the task's changes.
    click(viewButton('Tasks'))
    await until('task cards', () => document.querySelectorAll('.task-card').length === 2)
    await until('task card changes', () =>
      document.querySelector('.task-card.active')?.textContent.includes('±1'),
    )

    // git refuses to remove a dirty worktree; the task stays.
    let refused = false
    await smoke.removeTask(task.id, true).catch(() => {
      refused = true
    })
    assert(refused && state().tasks.some((t) => t.id === task.id), 'dirty worktree removed')
    // A refused removal leaves the task's terminals running.
    assert(state().sessions[taskSid]?.running, 'a refused removal stopped task terminals')
    await smoke.terminalWrite(shellSid, 'rm smoke.txt\r')
    await sleep(800)
    await smoke.removeTask(task.id, true)
    // Removing stops the task's terminals, but not the open worktree's.
    await until('task terminals stopped', () => !state().sessions[taskSid]?.running)
    assert(state().sessions[mainSid]?.running, 'removing a task stopped the open worktree')
    assert(state().tasks.length === 0 && state().activeTask === null, 'task not removed')
    task = undefined
    await smoke.report('PASS tasks: create, parallel worktree terminals, badges, review, remove')
  } catch (e) {
    smoke.resetSessions(await smoke.terminalReset())
    if (task) await smoke.removeTask(task.id, false).catch(() => {})
    await smoke.report(`FAIL tasks: ${e?.message ?? e}`)
  }
})()
