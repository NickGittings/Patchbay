// Workspace view smoke test. Uses a local stand-in agent to verify real planner
// PTY context and restart behavior without requiring an installed AI agent CLI.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 15000) => {
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
  const click = (el) => {
    if (!el) throw new Error('missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const nodeElement = (id) => document.querySelector(`.react-flow__node[data-id="${id}"]`)
  const viewButton = (name) =>
    Array.from(document.querySelectorAll('.view-switcher button')).find(
      (b) => b.textContent === name,
    )
  const textOf = (sid) => smoke.terminalText(sid).text
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }

  try {
    const { project: detected } = await smoke.openProject(window.__PATCHBAY_SMOKE_ROOT)
    const component = (id, x) => ({
      id,
      name: id.toUpperCase(),
      kind: 'library',
      path: '.',
      notes: `${id} notes`,
      position: { x, y: 0 },
      terminals: [{ id: 'task', name: 'Task', command: 'cat', kind: 'task' }],
    })
    const project = {
      ...detected,
      components: ['alpha', 'beta', 'nearby', 'unrelated'].map((id, i) => component(id, i * 320)),
      links: [
        { id: 'ab', source: 'alpha', target: 'beta', label: 'calls' },
        { id: 'bn', source: 'beta', target: 'nearby', label: 'uses' },
      ],
    }
    state().loadProject(project)
    state().setDevices([
      {
        id: 'smoke-planner',
        name: 'Smoke planner',
        category: 'agents',
        source: 'builtin',
        kind: 'agent',
        command: 'printf "planner-root:%s\\n" "$PWD"; cat "$PATCHBAY_CONTEXT_FILE"; exec cat',
      },
    ])
    await until(
      'navigation layout',
      () => document.querySelector('.hierarchy') && nodeElement('alpha'),
    )
    const viewport = () => document.querySelector('.react-flow__viewport')?.style.transform
    await until(
      'canvas dimensions',
      () => document.querySelector('.canvas').getBoundingClientRect().height > 100,
    )
    await sleep(200)
    const initialViewport = viewport()
    click(document.querySelector('.react-flow__controls-zoomin'))
    await until('zoomed viewport', () => viewport() !== initialViewport)
    await sleep(100)
    const savedViewport = viewport()
    const baseline = JSON.stringify(state().toProject())
    click(viewButton('Plan'))
    await until('plan layout', () => document.querySelector('.plan-dock') && nodeElement('alpha'))
    await until(
      `plan viewport restored (${savedViewport})`,
      () => viewport() === savedViewport,
    ).catch((e) => {
      throw new Error(`${e.message}; got ${viewport()}`)
    })
    assert(
      document.querySelector('.canvas').getBoundingClientRect().height > 100,
      'plan canvas has no height',
    )
    assert(
      document.querySelector('.planner-terminal').getBoundingClientRect().height > 100,
      'planner dock has no height',
    )
    assert(
      !document.querySelector('.react-flow__controls-interactive'),
      'plan can enable canvas editing',
    )
    click(nodeElement('alpha'))
    click(nodeElement('beta'))
    await until('highlighted set', () => state().highlighted.length === 2)
    await until(
      'node styles',
      () =>
        nodeElement('alpha').querySelector('.highlighted') &&
        nodeElement('nearby').querySelector('.nearby') &&
        nodeElement('unrelated').querySelector('.dimmed') &&
        document.querySelector('.plan-active-edge'),
    )
    document.querySelector('.react-flow').focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    click(document.querySelector('.react-flow__pane'))
    await sleep(150)
    assert(
      state().nodes.length === 4 && state().edges.length === 2,
      'planning deletes components or links',
    )
    assert(state().highlighted.length === 2, 'pane click clears highlights')
    // Chips must not switch the Navigation dock while planning.
    click(nodeElement('alpha').querySelector('.terminal-chips .chip'))
    assert(state().activeSession === null, 'planner chip changes navigation session')
    assert(state().highlighted.length === 2, 'planner chip changes highlights')
    click(document.querySelector('.plan-scope summary'))
    await until('context preview', () =>
      document
        .querySelector('.plan-scope pre')
        ?.textContent.includes('**ALPHA** depends on **BETA** — calls'),
    )
    const sid = '@plan/smoke-planner'
    await smoke.startTerminal('@plan', 'smoke-planner')
    await until('planner running', () => state().sessions[sid]?.running)
    await until(
      'planner briefing',
      () => textOf(sid).includes('## Nearby components') && textOf(sid).includes('nearby notes'),
    )
    assert(
      textOf(sid).includes(`planner-root:${project.root}`),
      'planner is not rooted in the project',
    )
    assert(!textOf(sid).includes('unrelated notes'), 'planner includes unrelated components')
    assert(state().planStartedWith[sid] === 'alpha,beta', 'planner launch scope was not recorded')
    state().toggleHighlight('beta')
    await until('stale hint', () => document.querySelector('.planner-stale'))
    click(
      Array.from(document.querySelectorAll('.planner-terminal .tab-actions button')).find((b) =>
        b.textContent.includes('Restart'),
      ),
    )
    await until(
      'restarted planner',
      () => state().sessions[sid]?.running && state().planStartedWith[sid] === 'alpha',
    )
    await until('stale hint cleared', () => !document.querySelector('.planner-stale'))
    await smoke.terminalWrite(sid, 'scrollback-$((6*7))\r')
    await until('scrollback marker', () => textOf(sid).includes('scrollback-'))
    click(viewButton('Implementation'))
    await until('implementation grid', () =>
      document.querySelector('.implementation-view .terminal-tile'),
    )
    assert(
      document.querySelector('.implementation-view .terminal-area').getBoundingClientRect().height >
        100,
      'implementation terminal has no height',
    )
    assert(!document.querySelector('.file-tree'), 'implementation has a file tree')
    const betaPill = Array.from(document.querySelectorAll('.component-pill')).find((b) =>
      b.textContent.includes('BETA'),
    )
    click(betaPill)
    await until('implementation selection', () => state().selectedId === 'beta')
    click(
      Array.from(document.querySelectorAll('.implementation-header > button')).find((b) =>
        b.textContent.includes('Start all'),
      ),
    )
    await until('start all', () => state().sessions['beta/task']?.running)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    await until('navigation shortcut', () => document.querySelector('.hierarchy'))
    await until('navigation viewport restored', () => viewport() === savedViewport)
    assert(state().selectedId === 'beta', 'selection is not shared with navigation')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }))
    await until('plan shortcut', () => document.querySelector('.plan-dock'))
    assert(textOf(sid).includes('scrollback-'), 'planner scrollback disappeared')
    assert(
      JSON.stringify(state().toProject()) === baseline && !state().dirty,
      'view actions changed the saved model',
    )
    state().onNodesChange([{ type: 'remove', id: 'alpha' }])
    assert(state().highlighted.length === 0, 'removed highlight was not pruned')
    smoke.resetSessions(await smoke.terminalReset())
    state().loadProject({ ...project, name: 'another-project' })
    assert(
      state().highlighted.length === 0 && Object.keys(state().planStartedWith).length === 0,
      'project change retains planner scope',
    )
    assert(
      Object.keys(state().sessions).length === 0 && !textOf(sid),
      'project change retains planner sessions',
    )
    await smoke.report(
      'PASS views: scope, context, restart, scrollback, shortcuts, implementation, project reset',
    )
  } catch (e) {
    await smoke.report(`FAIL views: ${e?.message ?? e}`)
  }
})()
