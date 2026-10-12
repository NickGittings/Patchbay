// Exercises the Sessions panel in a real desktop webview with two isolated project fixtures.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const panel = () => document.querySelector('.sessions-panel')
  // Helpers return nothing for missing elements, so `until` keeps polling through re-renders.
  const group = (name) =>
    [...document.querySelectorAll('.session-list > section')].find(
      (section) => section.querySelector('h3')?.textContent === name,
    )
  const rows = (name) => [...(group(name)?.querySelectorAll('.session-row') ?? [])]
  const names = (name) => rows(name).map((row) => row.querySelector('strong')?.textContent)
  const row = (project, name) =>
    rows(project).find((element) => element.querySelector('strong')?.textContent === name)
  const sessionMenu = () =>
    document.body.querySelector('[role="menu"][aria-label="More session actions"]')
  // Smoke windows never blur, so opening one menu doesn't close another; close it explicitly,
  // leaving at most one open for `sessionMenu`.
  const openOnly = (trigger) => {
    for (const other of document.querySelectorAll(
      '.session-menu .menu-trigger[aria-expanded="true"]',
    ))
      if (other !== trigger) other.click()
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
  }
  const openMenu = async (scope) => {
    const trigger = await until('session menu trigger', () =>
      scope()?.querySelector('.session-menu .menu-trigger'),
    )
    openOnly(trigger)
    return until(
      'session menu open',
      () => trigger.getAttribute('aria-expanded') === 'true' && sessionMenu(),
    )
  }
  const menuItem = (label) =>
    [...(sessionMenu()?.querySelectorAll('[role="menuitem"]') ?? [])].find(
      (element) => element.textContent.trim() === label,
    )
  const closeMenu = async (scope) => {
    scope().querySelector('.session-menu .menu-trigger').click()
    await until('session menu closed', () => !sessionMenu())
  }
  const click = async (scope, label) => {
    let opened
    const button = await until(`${label} button`, () => {
      const element = [...(scope()?.querySelectorAll('button') ?? [])].find(
        (element) => element.textContent.trim() === label,
      )
      if (element) {
        // The label turned up inline after all: close the menu this helper opened.
        if (opened?.getAttribute('aria-expanded') === 'true') opened.click()
        opened = undefined
        return !element.disabled && element
      }
      // Only a row's own menu: opening one elsewhere would leave it grabbing focus and presses.
      if (!scope()?.classList.contains('session-row')) return undefined
      const trigger = scope().querySelector('.session-menu .menu-trigger')
      if (!trigger) return undefined
      if (trigger.getAttribute('aria-expanded') !== 'true') {
        openOnly(trigger)
        opened = trigger
      }
      const item = menuItem(label)
      return item && !item.disabled && item
    })
    button.click()
  }
  // Callers wait for the rows they expect; the select's own value proves nothing rendered.
  const choose = async (name, index, value) => {
    const select = await until(`${name} select ${index}`, () => {
      const element = group(name)?.querySelectorAll('select')[index]
      return element && !element.disabled && element
    })
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const addSessions = async (opened) => {
    smoke.acceptOpened(opened)
    const component = state().nodes[0]
    const terminals = ['Live A', 'Live B', 'Done A', 'Done B'].map((name, i) => ({
      id: `session-${i}`,
      name,
      kind: 'task',
      command: i < 2 ? 'echo live-output; sleep 600' : 'echo finished-output',
    }))
    state().updateComponent(component.id, { terminals })
    const ids = []
    for (const terminal of terminals) {
      await smoke.startTerminal(component.id, terminal.id)
      const id = smoke.sessionId(component.id, terminal.id)
      ids.push(id)
      await until(`${opened.project.name} ${terminal.name} started`, async () => {
        await smoke.reconcileSessions()
        const record = state().sessionRecords.find((r) => r.id === id)
        return terminal.name.startsWith('Live')
          ? record?.snapshot?.running
          : record?.snapshot && !record.snapshot.running
      })
      await sleep(100)
    }
    return ids
  }
  let taskProjectId
  const createdTasks = []
  let failure
  let result
  const cleanupWorktrees = async () => {
    if (!createdTasks.length) return
    if (!state().projects[taskProjectId]?.state) smoke.acceptOpened(await smoke.openProject())
    state().activateProject(taskProjectId)
    const failures = []
    for (const task of createdTasks) {
      try {
        await smoke.removeTask(task.id, true)
      } catch (error) {
        failures.push(`${task.title}: ${error.message ?? error}`)
      }
    }
    // removeTask deliberately keeps branches; these disposable smoke branches have no commits.
    state().setActiveTask(null)
    const { rootTerminals, activeSession, maximizedTerminal } = state()
    const terminal = state().addRootTerminal({
      id: 'smoke-cleanup',
      name: 'Smoke branch cleanup',
      kind: 'task',
      command: `git branch -d -- ${createdTasks.map((t) => t.branch).join(' ')}`,
    })
    const sid = smoke.sessionId('@task', terminal, null, taskProjectId)
    try {
      await smoke.startTerminal('@task', terminal, null)
      const snapshot = await until('smoke branches removed', async () => {
        await smoke.reconcileSessions()
        const snapshot = state().sessionRecords.find((r) => r.id === sid)?.snapshot
        return snapshot && !snapshot.running && snapshot
      })
      assert(snapshot.exitCode === 0, 'Could not remove smoke branches')
    } catch (error) {
      failures.push(`branch cleanup: ${error.message ?? error}`)
    } finally {
      try {
        await smoke.terminalStop(sid)
        await until(
          'cleanup terminal stopped',
          async () => !(await smoke.terminalSnapshot(sid))?.running,
        )
        if ((await smoke.sessionsList()).some((r) => r.id === sid)) await smoke.sessionForget(sid)
        await smoke.reconcileSessions()
        assert(!state().sessionRecords.some((r) => r.id === sid), 'Cleanup session was retained')
      } catch (error) {
        failures.push(`cleanup terminal: ${error.message ?? error}`)
      } finally {
        smoke.store.setState({ rootTerminals, activeSession, maximizedTerminal })
      }
    }
    assert(!failures.length, `Cleanup failed: ${failures.join('; ')}`)
  }
  try {
    const one = await smoke.openProject()
    taskProjectId = one.id
    const idsOne = await addSessions(one)
    const two = await smoke.openSecondProject()
    const idsTwo = await addSessions(two)
    assert(await smoke.flushMapSaves(), 'Disposable session map saves failed')
    for (const opened of [await smoke.openProject(), await smoke.openSecondProject()]) {
      assert(
        opened.project.components.some(
          (c) =>
            c.terminals.length === 4 &&
            c.terminals.some((t) => t.id === 'session-0' && t.command.includes('live-output')),
        ),
        'Synthetic session presets were not persisted to their disposable map',
      )
    }
    const first = one.project.name
    const second = two.project.name
    await click(() => document, 'Sessions')
    await until('two project groups', () => group(first) && group(second))
    const headingOrder = () =>
      [...document.querySelectorAll('.session-list h3')].map((h) => h.textContent).join('|')
    const initialOrder = headingOrder()
    for (const name of [first, second]) {
      const selects = group(name).querySelectorAll('select')
      assert(selects[0].value === 'all' && selects[1].value === 'latest', 'Incorrect defaults')
      assert(
        [...selects].every((select) => select.getAttribute('aria-label').includes(name)),
        'Controls lack project labels',
      )
      assert(
        rows(name).every((element) => {
          const time = element.querySelector('time')
          return time?.title && time.dateTime && time.textContent.includes('ago')
        }),
        'Activity timestamps lack relative text or exact tooltip',
      )
    }
    assert(
      [first, second].every((name) =>
        rows(name).every((element) => element.querySelectorAll(':scope > button').length <= 2),
      ),
      'Session rows have more than two inline actions',
    )
    assert(
      !row(first, 'Live A').querySelector('.session-menu'),
      'Live non-agent session has an empty menu',
    )
    const menuTrigger = row(first, 'Done A').querySelector('.session-menu .menu-trigger')
    menuTrigger.focus()
    menuTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await until(
      'keyboard opens session menu with first item focused',
      () => menuItem('Start new') === document.activeElement,
    )
    await until('portalled menu receives pointer input above the dialog', () => {
      const item = menuItem('Start new')
      const rect = item.getBoundingClientRect()
      return item.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      )
    })
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    )
    await until('keyboard moves to Forget', () => menuItem('Forget') === document.activeElement)
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await until(
      'Escape closes menu and restores trigger focus',
      () => !sessionMenu() && document.activeElement === menuTrigger,
    )
    // Render agent controls on real session rows without launching an external provider.
    const renderAgentRows = () => {
      const records = state().sessionRecords
      if (records.some((r) => [idsOne[0], idsOne[2]].includes(r.id) && !r.metadata.adapter))
        smoke.store.setState({
          sessionRecords: records.map((r) =>
            [idsOne[0], idsOne[2]].includes(r.id)
              ? { ...r, metadata: { ...r.metadata, adapter: 'claude' } }
              : r,
          ),
        })
    }
    // Keep these UI fixtures in place across the real service's periodic reconciliation.
    const unsubscribeAgentRows = smoke.store.subscribe(renderAgentRows)
    renderAgentRows()
    try {
      await until('ended agent has View output and Resume inline', () => {
        const buttons = row(first, 'Done A').querySelectorAll(':scope > button')
        return [...buttons].map((button) => button.textContent).join('|') === 'View output|Resume'
      })
      await openMenu(() => row(first, 'Live A'))
      assert(
        sessionMenu().querySelectorAll('[role="menuitem"]').length === 1 &&
          menuItem('Set conversation ID…'),
        'Live agent menu has incorrect actions',
      )
      await click(() => row(first, 'Live A'), 'Set conversation ID…')
      await until('conversation ID form opened', () => panel().querySelector('form input'))
      await click(() => panel().querySelector('form'), 'Cancel')
      await openMenu(() => row(first, 'Done A'))
      assert(
        [...sessionMenu().querySelectorAll('[role="menuitem"]')]
          .map((item) => item.textContent)
          .join('|') === 'Start new|Set conversation ID…|Forget' &&
          sessionMenu().querySelector('[role="separator"]'),
        'Ended agent menu has incorrect actions',
      )
      await closeMenu(() => row(first, 'Done A'))
    } finally {
      unsubscribeAgentRows()
      // Strip only the fake adapter: the service may have reconciled these records meanwhile.
      smoke.store.setState({
        sessionRecords: state().sessionRecords.map((r) => {
          if (![idsOne[0], idsOne[2]].includes(r.id)) return r
          const { adapter: _adapter, ...metadata } = r.metadata
          return { ...r, metadata }
        }),
      })
    }
    await choose(first, 0, 'running')
    await choose(first, 1, 'oldest')
    await choose(second, 0, 'closed')
    await until(
      'independent filter and sort results',
      () =>
        names(first).join('|') === 'Live A|Live B' && names(second).join('|') === 'Done B|Done A',
    )
    assert(headingOrder() === initialOrder, 'Filtering reordered project groups')
    await click(() => row(first, 'Live A'), 'Reconnect')
    await until('running preview', () => document.querySelector('.session-preview'))
    await until('preview output', () => smoke.terminalText(idsOne[0]).text.includes('live-output'))
    await choose(first, 0, 'closed')
    assert(document.querySelector('.session-preview'), 'Filtering hid an open preview')
    await choose(first, 0, 'running')
    await click(panel, 'Close')
    await until('closed panel', () => !panel())
    await click(() => document, 'Sessions')
    await until(
      'reopened choices',
      () =>
        group(first)?.querySelectorAll('select')[0].value === 'running' &&
        group(first)?.querySelectorAll('select')[1].value === 'oldest' &&
        group(second)?.querySelectorAll('select')[0].value === 'closed' &&
        group(second)?.querySelectorAll('select')[1].value === 'latest',
    )
    await click(() => row(first, 'Live A'), 'Stop')
    await until('first stopped session disappears', () => !names(first).includes('Live A'))
    await click(() => row(first, 'Live B'), 'Stop')
    await until(
      'empty running group',
      () => names(first).length === 0 && group(first).textContent.includes('No running sessions'),
    )
    assert(
      group(first).querySelectorAll('select').length === 2,
      'Empty running group lost controls',
    )
    await choose(first, 0, 'closed')
    await click(() => row(first, 'Done A'), 'View output')
    await until(
      'closed output preview',
      () => document.querySelector('.session-preview strong')?.textContent === 'Done A',
    )
    await until('closed preview output', () =>
      smoke.terminalText(idsOne[2]).text.includes('finished-output'),
    )
    await click(() => row(first, 'Live A'), 'Start new')
    await until(
      'restarted session disappears from closed filter',
      () => !names(first).includes('Live A'),
    )
    await click(() => row(second, 'Done A'), 'Forget')
    await until('forgotten session disappears', () => !names(second).includes('Done A'))
    await click(() => row(second, 'Done B'), 'Forget')
    await until(
      'empty closed group',
      () => names(second).length === 0 && group(second).textContent.includes('No closed sessions'),
    )
    assert(
      group(second).querySelectorAll('select').length === 2,
      'Empty closed group lost controls',
    )
    // Closing the project's tab does not turn its detached running processes into Closed.
    state().closeProject(two.id)
    await smoke.reconcileSessions()
    await choose(second, 0, 'running')
    await until('detached running sessions', () => names(second).length === 2)
    assert(
      idsTwo
        .slice(0, 2)
        .every((id) => state().sessionRecords.find((r) => r.id === id)?.snapshot.running),
      'Closing a project tab changed running state',
    )
    // Global stop includes detached projects and rows hidden by independent filters.
    await choose(second, 0, 'closed')
    const globalStop = () =>
      [...panel().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop all work')
    smoke.store.setState({ serviceConnected: false })
    await until('global Stop disabled while disconnected', () => globalStop()?.disabled)
    smoke.store.setState({ serviceConnected: true })
    await click(panel, 'Stop all work')
    await until('global Stop confirmation', () => panel().querySelector('[role="alertdialog"]'))
    assert(
      state().sessionRecords.some((r) => r.snapshot?.running),
      'Opening global Stop confirmation stopped work',
    )
    await click(() => panel().querySelector('[role="alertdialog"]'), 'Cancel')
    await until(
      'global Stop confirmation cancelled',
      () => !panel().querySelector('[role="alertdialog"]'),
    )
    await smoke.reconcileSessions()
    assert(
      idsTwo
        .slice(0, 2)
        .every((id) => state().sessionRecords.find((r) => r.id === id)?.snapshot.running),
      'Cancelling global Stop confirmation stopped hidden work',
    )
    await click(panel, 'Stop all work')
    await click(() => panel().querySelector('[role="alertdialog"]'), 'Stop every project')
    await until(
      'global Stop started or completed',
      () => globalStop()?.disabled || state().sessionRecords.every((r) => !r.snapshot?.running),
    )
    await until('all projects stopped', async () => {
      await smoke.reconcileSessions()
      return state().sessionRecords.every((r) => !r.snapshot?.running)
    })
    assert(panel() && state().serviceConnected, 'Global stop closed the app or service')
    assert(document.querySelector('.session-preview'), 'Global stop removed retained preview')
    await choose(first, 0, 'closed')
    await click(() => row(first, 'Live A'), 'Start new')
    await until('new work after global stop', async () => {
      await smoke.reconcileSessions()
      return state().sessionRecords.some(
        (r) => r.metadata.projectId === one.id && r.snapshot?.running,
      )
    })
    await choose(first, 0, 'running')
    // Render the record-before-snapshot state while its real process remains stoppable.
    smoke.store.setState({
      sessionRecords: state().sessionRecords.map((r) =>
        r.id === idsOne[0] ? { ...r, snapshot: undefined, interrupted: false } : r,
      ),
    })
    await until('starting row has enabled Stop', () => {
      const element = row(first, 'Live A')
      return (
        element?.textContent.includes('Starting') &&
        [...element.querySelectorAll('button')].some(
          (b) => b.textContent.trim() === 'Stop' && !b.disabled,
        )
      )
    })
    await click(() => row(first, 'Live A'), 'Stop')
    await until('starting session stopped', async () => {
      await smoke.reconcileSessions()
      return !state().sessionRecords.find((r) => r.id === idsOne[0])?.snapshot?.running
    })
    await click(panel, 'Stop all work')
    await click(() => panel().querySelector('[role="alertdialog"]'), 'Stop every project')
    await until('cleanup completed', () => !globalStop()?.disabled)
    await choose(first, 0, 'closed')
    await click(() => row(first, 'Live A'), 'View output')
    const runSelect = await until('run history selector', () =>
      document.querySelector('.session-preview select[aria-label="Run"]'),
    )
    assert(runSelect.options[0].textContent === 'Current run', 'Missing current run option')
    assert(runSelect.options[1].textContent === 'Run 1', 'Missing numbered history option')
    runSelect.value = '0'
    runSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await until('selected history output', () =>
      document.querySelector('.session-preview pre')?.textContent.includes('live-output'),
    )
    runSelect.value = ''
    runSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await until(
      'current run restored',
      () =>
        !document.querySelector('.session-preview pre') &&
        document.querySelector('.session-preview .xterm-host'),
    )
    // Newer worktree sessions stay beneath their worktree, after the main worktree's rows.
    const zebra = await smoke.createTask({
      title: 'Zebra work',
      branch: 'smoke/sessions-zebra',
      components: [],
    })
    createdTasks.push(zebra)
    await smoke.startTerminal('@task', 'shell', zebra.id)
    const alpha = await smoke.createTask({
      title: 'Alpha work',
      branch: 'smoke/sessions-alpha',
      components: [],
    })
    createdTasks.push(alpha)
    await smoke.startTerminal('@task', 'shell', alpha.id)
    const worktrees = () => [...(group(first)?.querySelectorAll('.session-worktree') ?? [])]
    const worktree = (title) =>
      worktrees().find((w) => w.querySelector('h4')?.textContent === title)
    await choose(first, 0, 'all')
    await until('repo then worktrees then terminal rows', async () => {
      await smoke.reconcileSessions()
      return (
        worktrees()
          .map((w) => w.querySelector('h4').textContent)
          .join('|') === 'Main worktree|Alpha work|Zebra work' &&
        worktree('Alpha work').querySelectorAll('.session-row').length === 1 &&
        worktree('Zebra work').querySelectorAll('.session-row').length === 1
      )
    })
    assert(worktree('Alpha work').textContent.includes(alpha.worktree), 'Missing worktree path')
    assert(worktree('Zebra work').textContent.includes(zebra.worktree), 'Missing worktree path')
    assert(
      worktree('Main worktree').querySelectorAll('.session-row').length === 4,
      'Main worktree rows mixed with task terminals',
    )
    // Task labels also resolve from saved state while another project is active.
    smoke.acceptOpened(await smoke.openSecondProject())
    await until(
      'inactive project worktree labels',
      () => state().project?.id === two.id && worktree('Alpha work') && worktree('Zebra work'),
    )
    // A read-only panel must preserve inactive task layouts and Git badges, even disconnected.
    await click(panel, 'Close')
    await until('panel closed before restart check', () => !panel())
    const original = state().projects[one.id].state
    state().patchProject(one.id, {
      tasks: [],
      activeTask: 'temporarily-missing',
      taskWorkspaces: {
        ...original.taskWorkspaces,
        'temporarily-missing': {
          ...original.taskWorkspaces[''],
          panels: { retained: { left: 35, right: 65 } },
        },
      },
      gitChanges: { retained: 7 },
    })
    const inactive = state().projects[one.id].state
    smoke.store.setState({ serviceConnected: false })
    await click(() => document, 'Sessions')
    await until(
      'retained task labels without cached tasks',
      () => state().project?.id === two.id && worktree('Alpha work') && worktree('Zebra work'),
    )
    assert(state().projects[one.id].state === inactive, 'Opening Sessions changed an inactive tab')
    // Remove previous rendered groups before testing the legacy read-only lookup.
    await click(panel, 'Close')
    await until('panel closed before legacy check', () => !panel())
    // Old service records may lack names; their Tauri lookup must not reconcile project state.
    smoke.store.setState({
      sessionRecords: state().sessionRecords.map((r) =>
        r.metadata.projectId === one.id && r.metadata.task
          ? { ...r, metadata: { ...r.metadata, taskTitle: null } }
          : r,
      ),
    })
    await click(() => document, 'Sessions')
    await until(
      'legacy task names while disconnected',
      () => worktree('Alpha work') && worktree('Zebra work'),
    )
    assert(
      state().projects[one.id].state === inactive,
      'Legacy task lookup changed an inactive tab',
    )
    smoke.store.setState({ serviceConnected: true })
    await smoke.reconcileSessions()
    state().patchProject(one.id, {
      tasks: original.tasks,
      activeTask: original.activeTask,
      taskWorkspaces: original.taskWorkspaces,
      gitChanges: original.gitChanges,
    })
    const alphaPath = worktree('Alpha work').querySelector(
      '.session-worktree-heading small',
    ).textContent
    state().closeProject(one.id)
    await until('closed project labels', () => worktree('Alpha work') && worktree('Zebra work'))
    const endedNames = rows(first)
      .filter((element) => element.querySelector('button')?.textContent === 'View output')
      .map((element) => element.querySelector('strong').textContent)
    assert(endedNames.length, 'No ended sessions to check Start new')
    for (const name of endedNames) {
      await openMenu(() => row(first, name))
      await until('closed project disables Start new', () => menuItem('Start new')?.disabled)
      await closeMenu(() => row(first, name))
    }
    assert(
      worktree('Alpha work').querySelector('.session-worktree-heading small').textContent ===
        alphaPath,
      'Closing a project changed its worktree path',
    )
    smoke.acceptOpened(await smoke.openProject())
    state().activateProject(two.id)
    await openMenu(() => row(first, endedNames[0]))
    await until('reopened project enables Start new', () => {
      const item = menuItem('Start new')
      return item && !item.disabled
    })
    await closeMenu(() => row(first, endedNames[0]))
    await choose(first, 0, 'running')
    await until(
      'empty main worktree hidden',
      () => !worktree('Main worktree') && worktrees().length === 2,
    )
    await click(() => worktree('Alpha work')?.querySelector('.session-row'), 'Reconnect')
    await until('worktree shell preview', () =>
      document.querySelector('.session-preview .hint')?.textContent.includes(alpha.worktree),
    )
    await click(() => worktree('Alpha work')?.querySelector('.session-row'), 'Stop')
    await until('only selected worktree stopped', async () => {
      await smoke.reconcileSessions()
      return (
        !worktree('Alpha work') &&
        worktree('Zebra work') &&
        state().sessionRecords.find((r) => r.metadata.task === zebra.id)?.snapshot?.running
      )
    })
    await click(panel, 'Stop all work')
    await click(() => panel().querySelector('[role="alertdialog"]'), 'Stop every project')
    await until('worktree cleanup completed', () => !globalStop()?.disabled)
    result =
      'PASS sessions: repo/worktree/terminal hierarchy, inactive project labels, worktree filtering and actions, independent filters and sorting, activity tooltips, reopening, empty groups, retained preview, Reconnect/View/Stop/Start/Forget, compact agent menus, keyboard and pointer access, run history selection, detached running work, global stop across filters, stopping Starting rows, new work after global stop'
  } catch (error) {
    failure = error.message ?? String(error)
  } finally {
    try {
      await cleanupWorktrees()
    } catch (error) {
      failure = [failure, error.message ?? String(error)].filter(Boolean).join('; ')
    }
  }
  await smoke.report(failure ? `FAIL sessions: ${failure}` : result)
})()
