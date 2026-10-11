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
  const click = async (scope, label) => {
    const button = await until(`${label} button`, () =>
      [...(scope()?.querySelectorAll('button') ?? [])].find(
        (element) => element.textContent.trim() === label && !element.disabled,
      ),
    )
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
  try {
    const one = await smoke.openProject()
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
    await smoke.report(
      'PASS sessions: independent filters and sorting, activity tooltips, reopening, empty groups, retained preview, Reconnect/View/Stop/Start/Forget, detached running work, global stop across filters, stopping Starting rows, new work after global stop',
    )
  } catch (error) {
    await smoke.report(`FAIL sessions: ${error.message ?? error}`)
  }
})()
