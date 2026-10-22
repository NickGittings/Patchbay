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
  try {
    await until('restore', () => !s().restoring && s().serviceConnected)
    // An unavailable sole project can be restored without an active project identity.
    const missing = {
      id: 'missing-project',
      name: 'Missing project',
      root: '/missing-project',
      fingerprint: 'absent',
      unavailable: 'Folder is unavailable',
    }
    smoke.store.setState({ projects: { [missing.id]: missing }, projectOrder: [missing.id] })
    const missingTab = await until('sole unavailable tab', () =>
      document.querySelector('.project-tab [role="tab"]'),
    )
    if (!missingTab.textContent.includes('Missing project (unavailable)'))
      throw new Error('Sole unavailable project lost its name or status')
    missingTab.click()
    await until('missing project recovery', () =>
      document.querySelector('.recovery-banner')?.textContent.includes(missing.root),
    )
    document.querySelector('[aria-label="Close Missing project"]').click()
    await until('missing project closed', () => !s().projects[missing.id])
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
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
      const tab = document.querySelector('.project-tab [role="tab"]')
      return tab?.textContent.includes(one.project.name) && tab.textContent.includes('(1 running)')
    })
    // Resize the native window so viewport media queries participate in the check.
    const toolbar = document.querySelector('.toolbar')
    const originalSize = { width: window.innerWidth, height: window.innerHeight }
    const originalProjects = s().projects
    const originalOrder = s().projectOrder
    const extraProjects = Array.from({ length: 4 }, (_, i) => ({
      ...missing,
      id: `overflow-project-${i}`,
      name: `Project with a deliberately long readable name ${i}`,
      root: `/missing-project-${i}`,
    }))
    const assertVisible = (element, container, label) => {
      const box = element.getBoundingClientRect()
      const bounds = container.getBoundingClientRect()
      if (
        box.width < 1 ||
        box.height < 1 ||
        box.left < bounds.left - 1 ||
        box.right > bounds.right + 1 ||
        box.top < bounds.top - 1 ||
        box.bottom > bounds.bottom + 1 ||
        box.bottom > window.innerHeight
      )
        throw new Error(`Toolbar clips ${label} at ${window.innerWidth}px`)
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      if (!(element.contains(hit) || element.closest('button')?.contains(hit)))
        throw new Error(`Toolbar blocks ${label} at ${window.innerWidth}px`)
    }
    const checkLayout = () => {
      // Budget independently of the toolbar's own bounds: wrapping forever must fail.
      if (toolbar.getBoundingClientRect().height > 122)
        throw new Error(`Toolbar consumes too much height at ${window.innerWidth}px`)
      const switcher = toolbar.querySelector('.view-switcher').getBoundingClientRect()
      if (Math.abs(switcher.x + switcher.width / 2 - window.innerWidth / 2) > 1)
        throw new Error(`View switcher is not centered at ${window.innerWidth}px`)
      for (const button of toolbar.querySelectorAll(
        '.toolbar-group:first-child > .menu > .menu-trigger, .toolbar-search, ' +
          '.view-switcher button, .toolbar-group.end > button, ' +
          '.toolbar-group.end > .menu > .menu-trigger',
      ))
        assertVisible(button, toolbar, button.textContent)
      const tabs = toolbar.querySelector('.project-tabs')
      assertVisible(tabs, toolbar, 'project tab strip')
      if (tabs.scrollWidth <= tabs.clientWidth)
        throw new Error('Multiple long project tabs should scroll')
      for (const tab of tabs.querySelectorAll('.project-tab')) {
        const name = tab.querySelector('.project-tab-name')
        if (name.getBoundingClientRect().width < 190)
          throw new Error('Project name shrank instead of scrolling')
        for (const part of tab.querySelectorAll(
          '.project-tab-name, .project-tab-status, button:not([role="tab"])',
        )) {
          // Every name, status and close target must be reachable by scrolling.
          const box = part.getBoundingClientRect()
          const bounds = tabs.getBoundingClientRect()
          tabs.scrollLeft += box.left - bounds.left - (bounds.width - box.width) / 2
          assertVisible(part, tabs, part.textContent)
          if (part.classList.contains('project-tab-status') && part.scrollWidth > part.clientWidth)
            throw new Error('Project status text is truncated')
        }
      }
      tabs.scrollLeft = 0
    }
    try {
      s().setView('navigation')
      await until('navigation toolbar', () => document.querySelector('.worktree-picker'))
      for (const count of [3, 5]) {
        smoke.store.setState({
          projects: {
            ...originalProjects,
            [one.id]: { ...originalProjects[one.id], name: 'Active project with a very long name' },
            ...Object.fromEntries(extraProjects.slice(0, count - 1).map((p) => [p.id, p])),
          },
          projectOrder: [one.id, ...extraProjects.slice(0, count - 1).map((p) => p.id)],
        })
        await until(
          `${count} project tabs`,
          () => document.querySelectorAll('.project-tab').length === count,
        )
        for (const width of [1440, 1200, 1100, 900]) {
          await smoke.resizeWindow(width, originalSize.height)
          await until(`viewport ${width}`, () => Math.abs(window.innerWidth - width) <= 1)
          if (matchMedia('(max-width: 1100px)').matches !== width <= 1100)
            throw new Error('Viewport media query did not follow the native window size')
          await sleep(100)
          checkLayout()
          // Labels truncate rather than wrap: one row, or two once the view switcher moves down.
          const budget = width <= 1300 ? 90 : 48
          if (toolbar.getBoundingClientRect().height > budget)
            throw new Error(`Toolbar wraps beyond its rows at ${width}px`)
          // Vary every changing right-hand label, including when Attention appears.
          const activity = [...toolbar.querySelectorAll('.toolbar-group.end > button')].find(
            (button) => button.textContent.startsWith('Activity'),
          )
          // Lengthen labels with probe elements, leaving React's own text nodes in place.
          const probes = [
            [activity, ' (running)'],
            [
              toolbar.querySelector('.worktree-picker-label'),
              ' A long worktree title (feature/settings-toolbar)',
            ],
            [toolbar.querySelector('.map-save-status [role="status"]'), ' changed externally'],
          ].map(([element, text]) => {
            const probe = document.createElement('span')
            probe.className = 'smoke-label-probe'
            probe.textContent = text
            return [element, probe]
          })
          const before = toolbar.getBoundingClientRect()
          const attention = document.createElement('div')
          attention.className = 'menu attention'
          const attentionButton = document.createElement('button')
          attentionButton.className = 'menu-trigger attention-button'
          const summary = document.createElement('span')
          summary.className = 'attention-summary'
          summary.textContent = '2 need input'
          attentionButton.append(summary)
          attention.append(attentionButton)
          try {
            for (const [element, probe] of probes) element.append(probe)
            activity.before(attention)
            checkLayout()
            if (Math.abs(toolbar.getBoundingClientRect().height - before.height) > 1)
              throw new Error(`Status changes shifted the workspace at ${width}px`)
          } finally {
            attention.remove()
            for (const [, probe] of probes) probe.remove()
          }
        }
      }
      toolbar.querySelector('.toolbar-search').click()
      const search = await until('toolbar file search', () =>
        document.querySelector('[aria-label="Quick file search"]'),
      )
      if (s().paletteOpen) throw new Error('Search button opened Commands')
      search.closest('.extension-overlay').click()
      await until(
        'file search closed',
        () => !document.querySelector('[aria-label="Quick file search"]'),
      )
      const projectMenu = toolbar.querySelector(
        '.toolbar-group:first-child > .menu > .menu-trigger',
      )
      projectMenu.click()
      const menu = toolbar.querySelector('.toolbar-group:first-child > .menu [role="menu"]')
      const commands = [...menu.querySelectorAll('[role="menuitem"]')].find((item) =>
        item.textContent.startsWith('Commands'),
      )
      if (!commands?.querySelector('kbd')) throw new Error('Commands shortcut is not visible')
      const menuItems = [...menu.querySelectorAll('[role="menuitem"]')]
      const close = menuItems.at(-1)
      if (
        close.textContent !== 'Close project' ||
        close.previousElementSibling?.role !== 'separator'
      )
        throw new Error('Close project is not isolated at the end of the Project menu')
      commands.click()
      await until('commands palette', () => s().paletteOpen)
      smoke.store.setState({ paletteOpen: false })
    } finally {
      smoke.store.setState({ projects: originalProjects, projectOrder: originalOrder })
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
      'PASS workspace: sole project recovery/name/running count, native viewport reflow, centered views, scrolling readable tabs/statuses, all toolbar hit targets, search/commands/menu separation, two project identities, live pop-out, tab switches, independent planner/layout, detached session discovery',
    )
  } catch (e) {
    await smoke.report(`FAIL workspace: ${e.message ?? e}`)
  }
})()
