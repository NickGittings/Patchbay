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
  const pill = (name) =>
    Array.from(document.querySelectorAll('.component-pill')).find((b) =>
      b.textContent.includes(name),
    )
  // React reads a form control's value through the native setter.
  const choose = (el, value) => {
    if (!el) throw new Error('missing form control')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  // A changes list (or its empty state) has loaded under `selector`; errors fail the run.
  const changesSettled = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return false
    const error = el.querySelector('.file-tree-error, .diff-error')
    if (error) throw new Error(`${selector}: ${error.textContent}`)
    return el.querySelector('.change-list') || el.textContent.includes('No uncommitted changes')
  }

  try {
    const { project: detected } = await smoke.openProject()
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
    // Canvas first: the Inspector opens with a selection, the dock only while terminals run.
    // Hidden panels collapse but stay mounted, so check their panel's size (padding overflows it).
    const visible = (selector) => {
      const rect = document.querySelector(selector)?.parentElement?.getBoundingClientRect()
      return !!rect && rect.width > 0 && rect.height > 0
    }
    assert(
      !visible('.inspector') && !visible('.terminal-dock'),
      'navigation opened with the inspector or dock',
    )
    click(nodeElement('unrelated'))
    await until('inspector on selection', () => visible('.inspector'))
    assert(!visible('.terminal-dock'), 'dock shown with nothing running')
    const unrelatedTask = smoke.sessionId('unrelated', 'task')
    await smoke.startTerminal('unrelated', 'task')
    await until('dock for a running terminal', () =>
      document.querySelector('.terminal-dock .tabs .tab.active'),
    )
    // Revealed, as a result or attention item does, so it stays listed once it exits.
    state().setActiveSession(unrelatedTask)
    smoke.stopTerminal(unrelatedTask)
    await until('stopped', () => state().sessions[unrelatedTask]?.running === false)
    assert(
      visible('.terminal-dock') && document.querySelector('.terminal-dock .tabs .tab.active'),
      'dock dropped the exited terminal it showed',
    )
    click(document.querySelector('.inspector-close'))
    await until(
      'inspector closed',
      () => !visible('.inspector') && document.querySelector('.inspector-toggle'),
    )
    assert(state().selectedId === 'unrelated', 'closing the inspector cleared the selection')
    click(nodeElement('unrelated'))
    assert(state().inspector === false, 'reselecting the same component reopened the inspector')
    click(document.querySelector('.terminal-dock .dock-close'))
    await until('dock hidden once nothing runs', () => !visible('.terminal-dock'))
    click(document.querySelector('.inspector-toggle'))
    await until('inspector toggled open', () => visible('.inspector'))
    state().select(null)
    state().setActiveSession(null)
    smoke.store.setState({ inspector: null })
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
    const sid = smoke.sessionId('@plan', 'smoke-planner')
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
    click(
      Array.from(document.querySelectorAll('.plan-implement button')).find((b) =>
        b.textContent.includes('Implement'),
      ),
    )
    await until('implementation grid', () =>
      document.querySelector('.implementation-view .terminal-tile'),
    )
    assert(
      document.querySelector('.implementation-view .terminal-area').getBoundingClientRect().height >
        100,
      'implementation terminal has no height',
    )
    assert(!document.querySelector('.file-tree'), 'implementation has a file tree')
    assert(
      document.querySelectorAll('.implementation-group').length === 1 &&
        document.querySelector('.implementation-group')?.textContent.includes('ALPHA'),
      'implementation does not show the highlighted component',
    )
    // ⌘-click works on several components side by side, sharing the planner's scope.
    pill('BETA').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    await until(
      'two components side by side',
      () => document.querySelectorAll('.implementation-group').length === 2,
    )
    assert(state().highlighted.join() === 'alpha,beta', 'cmd-click did not extend the scope')
    click(document.querySelector('.implementation-view button[aria-label^="Maximize"]'))
    await until(
      'maximized tile',
      () =>
        document.querySelectorAll('.implementation-view .terminal-tile').length === 1 &&
        document.querySelector('.implementation-view .terminal-tile.maximized'),
    )
    click(document.querySelector('.implementation-view button[aria-label^="Restore"]'))
    await until(
      'restored tiles',
      () => document.querySelectorAll('.implementation-view .terminal-tile').length === 2,
    )
    // A plain click shows one component again.
    click(pill('BETA'))
    await until('implementation selection', () => state().selectedId === 'beta')
    click(
      Array.from(document.querySelectorAll('.implementation-header > button')).find((b) =>
        b.textContent.includes('Start all'),
      ),
    )
    await until('start all', () => state().sessions[smoke.sessionId('beta', 'task')]?.running)
    assert(
      state().sessions[smoke.sessionId('beta', 'task')].startedMs > 0,
      'session has no start time',
    )
    click(
      Array.from(document.querySelectorAll('.implementation-header > button')).find((b) =>
        b.textContent.includes('Changes'),
      ),
    )
    await until('implementation changes panel', () =>
      changesSettled('.implementation-view .changes-panel'),
    )
    assert(
      document.querySelector('.implementation-view .terminal-tile'),
      'changes panel hides the terminals',
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', metaKey: true, bubbles: true }))
    await until('review shortcut', () => document.querySelector('.review-view'))
    await until('review list', () => changesSettled('.review-view'))
    if (document.querySelector('.review-view .change-list')) {
      await until('review diff', () => {
        const error = document.querySelector('.review-view .diff-error')
        if (error) throw new Error(error.textContent)
        const view = document.querySelector('.review-view .diff-view')
        return view && !view.classList.contains('diff-loading')
      })
    }
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
    // Rescan and Add repo share this merge path. It must preserve selection and
    // active sessions throughout the update, including intermediate snapshots.
    state().setView('implementation')
    state().onNodesChange([{ type: 'select', id: 'beta', selected: true }])
    const beforeAdd = state()
    let selectionChanged = false
    const unsubscribe = smoke.store.subscribe((s) => {
      if (s.selectedId !== 'beta' || s.view !== 'implementation') selectionChanged = true
    })
    const added = { ...component('added', 1280), path: 'devices' }
    assert(smoke.applyAdded({ components: [added], links: [] }, '') === 1, 'merge added nothing')
    unsubscribe()
    assert(!selectionChanged, 'merge temporarily clears selection or changes view')
    assert(
      state().activeSession === beforeAdd.activeSession &&
        state().sessions === beforeAdd.sessions &&
        state().highlighted === beforeAdd.highlighted &&
        state().planStartedWith === beforeAdd.planStartedWith &&
        state().nodes.find((n) => n.id === 'beta').selected,
      'merge loses session, planner, or canvas selection state',
    )
    await until('implementation still on beta', () =>
      document.querySelector('.implementation-view .terminal-tile')?.textContent.includes('Task'),
    )
    state().selectEdge('ab')
    state().onEdgesChange([{ type: 'select', id: 'ab', selected: true }])
    smoke.applyAdded(
      { components: [{ ...component('another', 1600), path: 'crates' }], links: [] },
      '',
    )
    assert(
      state().selectedEdgeId === 'ab' && state().edges.find((e) => e.id === 'ab').selected,
      'merge loses edge selection',
    )
    state().select('beta')
    assert(
      smoke.applyAdded({ components: [added], links: [] }, 'Already present') === 0 &&
        state().selectedId === 'beta',
      'adding an existing folder changes selection',
    )
    // Canvas deletion is a reviewed map edit; a raw remove change must not apply directly.
    state().onNodesChange([{ type: 'remove', id: 'alpha' }])
    assert(
      state().nodes.some((n) => n.id === 'alpha'),
      'raw node removal bypassed review',
    )
    assert(await smoke.removeComponents(['alpha']), 'component removal was refused')
    assert(state().highlighted.length === 0, 'removed highlight was not pruned')

    // Terminals added in Implementation are saved; agents there are told about their peers.
    state().setView('implementation')
    state().toggleHighlight('beta')
    state().toggleHighlight('nearby')
    await until(
      'beta and nearby',
      () => document.querySelectorAll('.implementation-group').length === 2,
    )
    const terminalsBefore = state().nodes.find((n) => n.id === 'beta').data.terminals.length
    choose(document.querySelector('.implementation-group select.add-terminal'), 'custom')
    await until(
      'added terminal',
      () =>
        state().nodes.find((n) => n.id === 'beta').data.terminals.length === terminalsBefore + 1,
    )
    assert(state().dirty, 'an added terminal is not a map edit')
    state().updateTerminal(
      'beta',
      state()
        .nodes.find((n) => n.id === 'beta')
        .data.terminals.at(-1).id,
      {
        kind: 'agent',
        command: 'cat "$PATCHBAY_CONTEXT_FILE"; exec cat',
      },
    )
    const briefTerminal = state()
      .nodes.find((n) => n.id === 'beta')
      .data.terminals.at(-1).id
    const briefSid = smoke.sessionId('beta', briefTerminal)
    await smoke.startTerminal('beta', briefTerminal)
    await until(
      'peer briefing',
      () =>
        textOf(briefSid).includes('## Working alongside') &&
        textOf(briefSid).includes('**NEARBY**'),
    )
    smoke.stopTerminal(briefSid)
    state().clearHighlights()

    // Status: an agent reporting through its status file, and a task printing a local URL.
    state().updateComponent('unrelated', {
      terminals: [
        {
          id: 'agent',
          name: 'Agent',
          kind: 'agent',
          command: `printf 'needs-input\\n{"message":"Allow smoke?"}' > "$PATCHBAY_STATUS_FILE"; cat`,
        },
        {
          id: 'server',
          name: 'Server',
          kind: 'task',
          command: "echo 'Local: http://localhost:9/'; cat",
        },
      ],
    })
    await smoke.startTerminal('unrelated', 'agent')
    await smoke.startTerminal('unrelated', 'server')
    await until(
      'agent needing input',
      () =>
        state().sessions[smoke.sessionId('unrelated', 'agent')]?.status?.agent?.message ===
        'Allow smoke?',
    )
    await until(
      'server URL',
      () =>
        state().sessions[smoke.sessionId('unrelated', 'server')]?.status?.url ===
        'http://localhost:9/',
    )
    const attention = await until('attention menu', () =>
      Array.from(document.querySelectorAll('.attention-button')).find((b) =>
        b.textContent.includes('1 need input'),
      ),
    )
    click(attention)
    click(await until('attention item', () => document.querySelector('.attention-item')))
    await until(
      'attention item reveals the agent',
      () =>
        state().view === 'implementation' &&
        state().selectedId === 'unrelated' &&
        state().activeSession === smoke.sessionId('unrelated', 'agent') &&
        document.querySelector('.implementation-view .status-label.health-input'),
    )
    smoke.stopTerminal(smoke.sessionId('unrelated', 'server'))
    await until('stopped server', () => {
      const server = state().sessions[smoke.sessionId('unrelated', 'server')]
      return server && !server.running && server.status?.stopped
    })
    assert(
      !document.querySelector('.attention-button')?.textContent.includes('failed') &&
        document.querySelector('.implementation-view .status-label.health-idle')?.textContent ===
          'Stopped',
      'a stopped task counts as failed',
    )

    const scopeBefore = [...state().highlighted]
    const plansBefore = { ...state().planStartedWith }
    state().loadProject(project)
    assert(
      JSON.stringify(state().highlighted) === JSON.stringify(scopeBefore),
      'Reopening a project lost planner scope',
    )
    assert(
      JSON.stringify(state().planStartedWith) === JSON.stringify(plansBefore),
      'Reopening a project lost planner history',
    )
    assert(
      Object.keys(state().sessions).length > 0 && textOf(sid),
      'Reopening a project lost retained sessions',
    )
    const secondary = { ...state().devices[0], id: 'other-planner', name: 'Other planner' }
    state().setDevices([...state().devices, secondary])
    state().setSession(smoke.sessionId('@plan', secondary.id), {
      running: false,
      exitCode: 1,
      exitedMs: Date.now(),
    })
    click(await until('planner attention menu', () => document.querySelector('.attention-button')))
    click(
      await until('second planner attention item', () =>
        [...document.querySelectorAll('.attention-item')].find((b) =>
          b.textContent.includes('Other planner'),
        ),
      ),
    )
    await until(
      'opaque planner attention navigation',
      () => state().view === 'plan' && state().planActive === secondary.id,
    )
    await smoke.report(
      'PASS views: scope, context, restart, scrollback, shortcuts, implementation, changes, review, merge selection, status, workspace continuity, multi-component implementation, peers',
    )
  } catch (e) {
    await smoke.report(`FAIL views: ${e?.message ?? e}`)
  }
})()
