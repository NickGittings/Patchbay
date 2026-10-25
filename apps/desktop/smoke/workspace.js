// Run with two backend-configured fixtures and an isolated PATCHBAY_STATE_DIR.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
  if (new URLSearchParams(location.search).has('component')) return
  const s = () => smoke.store.getState()
  const switcher = () =>
    document.querySelector('.project-list .panel-list-row button[aria-pressed="true"]') ??
    document.querySelector('.project-list .panel-list-row button')
  const projectMenu = async () => {
    smoke.selectPanel('project')
    return until('project panel list', () => document.querySelector('.project-list'))
  }
  try {
    await until('restore', () => !s().restoring && s().serviceConnected)
    await projectMenu()
    if (/mac/i.test(navigator.userAgent)) {
      const menu = await until('native menu without a project', async () => {
        const items = await smoke.inspectNativeMenu()
        return items.some(([id]) => id === 'patchbay:action:open') && items
      })
      for (const title of ['Project', 'Settings', 'Edit', 'Window'])
        if (!menu.some(([, text]) => text === title))
          throw new Error(`Missing native ${title} menu`)
      if (menu.find(([id]) => id === 'patchbay:action:save')?.[2])
        throw new Error('Native Save enabled without a project')
      if (!menu.find(([id]) => id === 'patchbay:action:notifications')?.[2])
        throw new Error('Native Notifications disabled without a project')
    }
    // An unavailable sole project can be restored without an active project identity.
    const missing = {
      id: 'missing-project',
      name: 'Missing project',
      root: '/missing-project',
      fingerprint: 'absent',
      unavailable: 'Folder is unavailable',
    }
    smoke.store.setState({ projects: { [missing.id]: missing }, projectOrder: [missing.id] })
    const missingTab = await until('sole unavailable project', () => switcher())
    if (
      !missingTab.textContent.includes('Missing project') ||
      !missingTab.querySelector('.worktree-tag.bad')
    )
      throw new Error('Sole unavailable project lost its name or status')
    ;[...(await projectMenu()).querySelectorAll('button[aria-pressed]')]
      .find((item) => item.textContent.includes('Missing project'))
      .click()
    await until('missing project recovery', () =>
      document.querySelector('.recovery-banner')?.textContent.includes(missing.root),
    )
    smoke.selectPanel(null)
    await until(
      'recovery visible with panel closed',
      () =>
        !document.querySelector('.utility-panel') &&
        document
          .querySelector('.workspace-main .recovery-banner')
          ?.textContent.includes(missing.root),
    )
    ;(await projectMenu()).querySelector('[aria-label="Close Missing project"]').click()
    await until('missing project closed', () => !s().projects[missing.id])
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    if (/mac/i.test(navigator.userAgent)) {
      await until(
        'native Save enabled with project',
        async () =>
          (await smoke.inspectNativeMenu()).find(([id]) => id === 'patchbay:action:save')?.[2],
      )
      await smoke.nativeMenuAction('action:notifications')
      const settings = await until('native action opens settings', () =>
        document.querySelector('[aria-label="Notifications"][role="dialog"]'),
      )
      settings.querySelector('[aria-label="Close Notifications"]').click()
    }
    const first = s().nodes[0]
    s().updateComponent(first.id, {
      terminals: [
        {
          id: 'counter',
          name: 'Counter',
          kind: 'task',
          command: 'echo process:$$; i=0; while :; do echo number:$i; i=$((i+1)); sleep 0.1; done',
        },
      ],
    })
    s().select(first.id)
    s().setView('plan')
    s().toggleHighlight(first.id)
    await smoke.startTerminal(first.id, 'counter')
    const sidOne = smoke.sessionId(first.id, 'counter')
    await until('first counter', () => s().sessions[sidOne]?.running)
    await until('sole project name and running count', () => {
      const tab = switcher()
      return (
        tab?.textContent.includes(one.project.name) &&
        tab.querySelector('.count')?.textContent === '1'
      )
    })
    // Both Project close entry points must confirm while work is running.
    const originalConfirm = window.confirm
    const confirmations = []
    try {
      window.confirm = (message) => {
        confirmations.push(message)
        return false
      }
      ;(await projectMenu()).querySelector(`[aria-label="Close ${one.project.name}"]`).click()
      await until('rail close confirmation', () => confirmations.length === 1)
      ;[...document.querySelectorAll('.project-actions button')]
        .find((button) => button.textContent === 'Close project')
        .click()
      await until('Project action close confirmation', () => confirmations.length === 2)
      if (!s().projects[one.id] || !s().sessions[sidOne]?.running)
        throw new Error('Canceling project close changed running work')
    } finally {
      window.confirm = originalConfirm
    }
    // Rail and dock remain usable down to the native minimum window size.
    const originalSize = { width: innerWidth, height: innerHeight }
    const originalPanelWidth = localStorage.getItem('patchbay.utilityPanelWidth')
    const originalProjects = s().projects
    const originalOrder = s().projectOrder
    try {
      smoke.store.setState({
        projects: {
          ...originalProjects,
          [one.id]: {
            ...originalProjects[one.id],
            name: 'A deliberately long project name '.repeat(5),
          },
        },
      })
      const rail = document.querySelector('.workspace-rail')
      const labels = [...rail.querySelectorAll(':scope > button')].map((b) =>
        b.getAttribute('aria-label'),
      )
      if (
        labels.join(',') !==
        'Project,Worktree,Navigation,Plan,Build,Review,Chat mode,Auto mode,Activity,Stack,Sessions'
      )
        throw new Error('Rail order changed')
      for (const width of [1440, 1200, 900]) {
        await smoke.resizeWindow(width, width === 900 ? 600 : originalSize.height)
        await until(`viewport ${width}`, () => Math.abs(innerWidth - width) <= 1)
        await sleep(100)
        for (const button of rail.querySelectorAll(':scope > button')) {
          const box = button.getBoundingClientRect()
          if (box.width < 30 || box.height < 30 || box.bottom > innerHeight || !button.title)
            throw new Error('Rail clips a hit target or lacks a tooltip')
        }
        smoke.selectPanel('project')
        const panel = await until('docked project panel', () =>
          document.querySelector('.utility-panel'),
        )
        const workspace = document.querySelector('.workspace-main')
        if (panel.getBoundingClientRect().right > workspace.getBoundingClientRect().left + 1)
          throw new Error('Panel overlaps workspace')
        if (workspace.clientWidth < 400) throw new Error('Panel leaves no usable workspace')
        const resize = document.querySelector('[aria-label="Resize utility panel"]')
        resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        await sleep(50)
        if (!localStorage.getItem('patchbay.utilityPanelWidth'))
          throw new Error('Panel width not persisted')
      }
      document.querySelector('.workspace-rail [aria-label="Plan"]').click()
      await until(
        'Plan with dock still open',
        () => s().view === 'plan' && document.querySelector('[aria-label="Project panel"]'),
      )
      document.querySelector('.workspace-rail [aria-label="Sessions"]').click()
      await until(
        'exclusive Sessions panel',
        () =>
          document.querySelector('[aria-label="Sessions panel"]') &&
          !document.querySelector('[aria-label="Project panel"]'),
      )
      const sessions = await until('portalled Sessions content', () =>
        document.querySelector('[aria-label="Workspace sessions"]'),
      )
      const filter = sessions.querySelector('select')
      filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      if (s().utilityPanel !== 'sessions') throw new Error('Escape in a select closed Sessions')
      sessions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await until(
        'Escape closes portalled Sessions',
        () => !document.querySelector('.utility-panel'),
      )
      // A failed map save must remain visible with the Project panel closed.
      const savedEntry = s().projects[one.id]
      smoke.store.setState({
        projects: {
          ...s().projects,
          [one.id]: { ...savedEntry, mapSave: { status: 'error', error: 'Smoke save failure' } },
        },
      })
      await until('visible save failure', () =>
        document
          .querySelector('.workspace-main [role="alert"]')
          ?.textContent.includes('Map save failed'),
      )
      const projectButton = document.querySelector('.workspace-rail [aria-label="Project"]')
      if (!projectButton.title.includes('Map save failed'))
        throw new Error('Project rail lost the save failure indicator')
      smoke.store.setState({ projects: { ...s().projects, [one.id]: savedEntry } })
      const search = document.querySelector('.top-bar input')
      if (
        search.getBoundingClientRect().height !== 28 ||
        search.getBoundingClientRect().width > 520
      )
        throw new Error('Search is no longer compact')
      if (/mac/i.test(navigator.userAgent) && search.getBoundingClientRect().left < 88)
        throw new Error('Search overlaps native window controls')
      search.focus()
      await until('combined search', () => document.querySelector('.search-results'))
      if (
        !document.querySelector('[role="group"][aria-label="Files"]') ||
        !document.querySelector('[role="group"][aria-label="Commands"]')
      )
        throw new Error('Search groups missing')
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await until('search dismissed', () => !document.querySelector('.search-results'))
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true, bubbles: true }),
      )
      await until(
        'commands prioritized and focused',
        () =>
          document.activeElement === search &&
          document.querySelector('.search-results h3')?.textContent === 'Commands',
      )
      // Closing results by an outside click can leave focus on the search input.
      const type = (value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, value)
        search.dispatchEvent(new Event('input', { bubbles: true }))
      }
      type('Notifications')
      await until('notification command selected', () =>
        document.querySelector('[data-command-id="notifications"][aria-selected="true"]'),
      )
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await until('outside click closes search', () => !document.querySelector('.search-results'))
      if (document.activeElement !== search)
        throw new Error('Outside click unexpectedly moved focus')
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(100)
      if (document.querySelector('[aria-label="Notifications"][role="dialog"]'))
        throw new Error('Enter executed a hidden search result')
      let storeWrites = 0
      const unsubscribe = smoke.store.subscribe(() => storeWrites++)
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      unsubscribe()
      if (storeWrites) throw new Error('A closed search wrote to the store on an outside click')
      type('Notification')
      await until('typing reopens results', () => document.querySelector('.search-results'))
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    } finally {
      smoke.store.setState({ projects: originalProjects, projectOrder: originalOrder })
      smoke.selectPanel(null)
      if (originalPanelWidth === null) localStorage.removeItem('patchbay.utilityPanelWidth')
      else localStorage.setItem('patchbay.utilityPanelWidth', originalPanelWidth)
      await smoke.resizeWindow(originalSize.width, originalSize.height)
      s().setView('plan')
    }
    await smoke.openComponentWindow(first.id, first.data.name)
    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    // Identical component/terminal identifiers must remain isolated.
    const project = s().toProject()
    s().syncProject({
      ...project,
      components: [
        {
          ...one.project.components[0],
          id: first.id,
          path: '.',
          terminals: [
            { id: 'counter', name: 'Counter', kind: 'task', command: 'echo second-only; sleep 30' },
          ],
        },
      ],
      links: [],
    })
    smoke.store.setState({ dirty: true })
    s().select(first.id)
    await smoke.startTerminal(first.id, 'counter')
    const sidTwo = smoke.sessionId(first.id, 'counter')
    if (sidOne === sidTwo) throw new Error('Project session IDs collided')
    await until('second counter', () => s().sessions[sidTwo]?.running)
    if (!s().sessions[sidOne]?.running) throw new Error('Switching stopped the first project')
    s().activateProject(one.id)
    if (s().view !== 'plan' || !s().highlighted.includes(first.id))
      throw new Error('Project layout/scope was lost')
    await until('continued output', () => smoke.terminalText(sidOne).text.includes('number:3'))
    s().activateProject(two.id)
    if (s().view !== 'navigation' || s().highlighted.length)
      throw new Error('Layouts leaked across projects')
    if (!(await smoke.flushMapSaves())) throw new Error('Disposable map saves failed')
    for (const opened of [await smoke.openProject(), await smoke.openSecondProject()]) {
      if (!opened.project.components.some((c) => c.terminals.some((t) => t.id === 'counter')))
        throw new Error('Synthetic counter preset was not persisted to its disposable map')
    }
    s().closeProject(one.id)
    await smoke.reconcileSessions()
    if (!s().sessionRecords.some((r) => r.id === sidOne && r.snapshot.running))
      throw new Error('Detached work is absent from Sessions')
    await smoke.report(
      'PASS workspace: project recovery/name/running count, rail order and hit targets, dock resizing/persistence, minimum viewport, grouped search and shortcuts, two project identities, live pop-out, tab switches, independent planner/layout, detached session discovery',
    )
  } catch (e) {
    await smoke.report(`FAIL workspace: ${e.message ?? e}`)
  }
})()
