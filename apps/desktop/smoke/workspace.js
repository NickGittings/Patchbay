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
    // Exercise toolbar reflow in the real webview without resizing the user's app window.
    const toolbar = document.querySelector('.toolbar')
    const originalWidth = toolbar.style.width
    try {
      const widths = [
        ...new Set([1440, 1200, 900].map((width) => Math.min(width, window.innerWidth))),
      ]
      for (const width of widths) {
        toolbar.style.width = `${width}px`
        s().setView('navigation')
        await until('navigation toolbar', () => document.querySelector('.worktree-picker'))
        await sleep(100)
        for (const button of toolbar.querySelectorAll('.view-switcher button')) {
          const box = button.getBoundingClientRect()
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          if (!button.contains(hit))
            throw new Error(`Toolbar blocks ${button.textContent} at ${width}px`)
        }
        const bounds = toolbar.getBoundingClientRect()
        for (const button of toolbar.querySelectorAll(
          '.toolbar-group.end > button, .toolbar-group.end > .menu > .menu-trigger',
        )) {
          const box = button.getBoundingClientRect()
          if (box.left < bounds.left || box.right > bounds.right || box.bottom > bounds.bottom)
            throw new Error(`Toolbar control overflows at ${width}px: ${button.textContent}`)
        }
      }
    } finally {
      toolbar.style.width = originalWidth
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
      'PASS workspace: sole project recovery/name/running count, responsive toolbar hit targets, two project identities, live pop-out, tab switches, independent planner/layout, detached session discovery',
    )
  } catch (e) {
    await smoke.report(`FAIL workspace: ${e.message ?? e}`)
  }
})()
