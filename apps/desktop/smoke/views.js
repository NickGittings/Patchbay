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
  const query = (selector) => document.querySelector(selector)
  const nodeElement = (id) => query(`.react-flow__node[data-id="${id}"]`)
  const viewButton = (name) =>
    Array.from(document.querySelectorAll('.workspace-rail > button')).find(
      (b) => b.getAttribute('aria-label') === name,
    )
  const textOf = (sid) => smoke.terminalText(sid).text
  const tiles = (id) => [...document.querySelectorAll(`.terminal-tile[data-component="${id}"]`)]
  // React reads a form control's value through the native setter.
  const choose = (el, value) => {
    if (!el) throw new Error('missing form control')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const assertScope = (ids) => {
    assert(state().highlighted.join() === ids.join(), 'incorrect task component scope')
  }
  // A changes list (or its empty state) has loaded under `selector`; errors fail the run.
  const changesSettled = (selector) => {
    const el = query(selector)
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
        adapter: 'claude',
        command:
          'printf "planner-root:%s\\n" "$PWD"; cat "$PATCHBAY_CONTEXT_FILE"; ' +
          'while IFS= read -r line; do printf "%s\\n" "$line"; ' +
          'if [ "$line" = "handoff" ]; then ' +
          `printf '%s' '{"hook_event_name":"PreToolUse","session_id":"smoke-native-plan","tool_name":"ExitPlanMode","tool_input":{"plan":"# Smoke handoff\\nImplement the saved plan."}}' | ` +
          '"${PATCHBAY_CLI%/*}/patchbay-sessiond" report-status claude; fi; done',
      },
    ])
    await until(
      'navigation layout',
      () => query('.navigation-shell .canvas') && nodeElement('alpha'),
    )
    state().setPaletteOpen(true)
    click(await until('Agent roles command', () => query('[data-command-id="roles"]')))
    const rolesPanel = await until('Agent roles panel', () => query('[aria-label="Agent roles"]'))
    // Check label association rather than focus: WebKit on macOS doesn't focus a select
    // through its label, and smoke windows never have focus anyway.
    for (const role of ['Plan', 'Implement', 'Fix', 'Merge']) {
      const select = rolesPanel.querySelector(`select[aria-label="${role}"]`)
      assert(select?.labels?.length === 1, `${role} select has no label`)
    }
    const subagentsLabel = [...rolesPanel.querySelectorAll('label')].find(
      (el) => el.textContent === 'Subagents',
    )
    const subagents = subagentsLabel?.control
    assert(subagents?.tagName === 'SELECT', 'missing subagent control')
    assert(
      [...subagents.options].map((o) => o.value).join() === '0,2,3,4,5,6,7,8',
      'incorrect subagent choices',
    )
    const beforeSubagents = JSON.stringify(state().toProject())
    const wasDirty = state().dirty
    choose(subagents, '3')
    await until('subagents selected', () => state().implementSubagents === 3)
    assert(
      state().dirty === wasDirty && JSON.stringify(state().toProject()) === beforeSubagents,
      'subagent setting changed the project map',
    )
    choose(subagents, '0')
    await until('subagents disabled', () => state().implementSubagents === 0)
    click([...rolesPanel.querySelectorAll('button')].find((b) => b.textContent === 'Close'))
    // Canvas first: the Inspector opens with a selection, the dock only while terminals run.
    // Hidden panels collapse but stay mounted, so check their panel's size (padding overflows it).
    const visible = (selector) => {
      const rect = query(selector)?.parentElement?.getBoundingClientRect()
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
    await until('dock for a running terminal', () => query('.terminal-dock .tabs .tab.active'))
    // Revealed, as a result or attention item does, so it stays listed once it exits.
    state().setActiveSession(unrelatedTask)
    smoke.stopTerminal(unrelatedTask)
    await until('stopped', () => state().sessions[unrelatedTask]?.running === false)
    assert(
      visible('.terminal-dock') && query('.terminal-dock .tabs .tab.active'),
      'dock dropped the exited terminal it showed',
    )
    click(query('.inspector-close'))
    await until('inspector closed', () => !visible('.inspector') && query('.inspector-toggle'))
    assert(state().selectedId === 'unrelated', 'closing the inspector cleared the selection')
    click(nodeElement('unrelated'))
    assert(state().inspector === false, 'reselecting the same component reopened the inspector')
    click(query('.terminal-dock .dock-close'))
    await until('dock hidden once nothing runs', () => !visible('.terminal-dock'))
    click(query('.inspector-toggle'))
    await until('inspector toggled open', () => visible('.inspector'))
    state().select(null)
    state().setActiveSession(null)
    smoke.store.setState({ inspector: null })
    const viewport = () => query('.react-flow__viewport')?.style.transform
    await until('canvas dimensions', () => query('.canvas').getBoundingClientRect().height > 100)
    await sleep(200)
    const initialViewport = viewport()
    click(query('.react-flow__controls-zoomin'))
    await until('zoomed viewport', () => viewport() !== initialViewport)
    await sleep(100)
    const savedViewport = viewport()
    const baseline = JSON.stringify(state().toProject())
    // Review and Implementation must not leave an editable canvas listening to document keys.
    for (const full of ['review', 'implementation']) {
      state().selectEdge('ab')
      state().setView(full)
      await until(`${full} without Navigation`, () => !query('.navigation-shell'))
      const confirm = window.confirm
      let prompts = 0
      window.confirm = () => {
        prompts++
        return false
      }
      try {
        for (const selection of ['edge', 'component']) {
          if (selection === 'component') state().select('alpha')
          document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
          )
          document.body.dispatchEvent(
            new KeyboardEvent('keyup', { key: 'Backspace', bubbles: true }),
          )
          await sleep(150)
          assert(prompts === 0, `${full} prompted to remove a hidden component`)
          assert(
            state().nodes.length === 4 && state().edges.length === 2,
            `${full} deleted hidden map elements`,
          )
        }
      } finally {
        window.confirm = confirm
      }
    }
    state().select(null)
    state().selectEdge(null)
    state().setActiveSession(null)
    click(viewButton('Plan'))
    await until('plan layout', () => query('.plan-dock') && nodeElement('alpha'))
    await until(
      `plan viewport restored (${savedViewport})`,
      () => viewport() === savedViewport,
    ).catch((e) => {
      throw new Error(`${e.message}; got ${viewport()}`)
    })
    assert(query('.canvas').getBoundingClientRect().height > 100, 'plan canvas has no height')
    assert(
      query('.planner-terminal').getBoundingClientRect().height > 100,
      'planner dock has no height',
    )
    assert(!query('.react-flow__controls-interactive'), 'plan can enable canvas editing')
    click(nodeElement('alpha'))
    click(nodeElement('beta'))
    await until('highlighted set', () => state().highlighted.length === 2)
    await until(
      'node styles',
      () =>
        nodeElement('alpha').querySelector('.highlighted') &&
        nodeElement('nearby').querySelector('.nearby') &&
        nodeElement('unrelated').querySelector('.dimmed') &&
        query('.plan-active-edge'),
    )
    query('.react-flow').focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
    click(query('.react-flow__pane'))
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
    click(query('.plan-scope summary'))
    await until('context preview', () =>
      document
        .querySelector('.plan-scope pre')
        ?.textContent.includes('**ALPHA** depends on **BETA** — calls'),
    )
    const plannerStarts = [...document.querySelectorAll('.planner-terminal button')].filter(
      (button) => button.textContent.trim().startsWith('▶ Start'),
    )
    assert(plannerStarts.length === 1, 'planner must offer exactly one Start action')
    assert(!document.querySelector('.planner-terminal .terminal-overlay'), 'empty agent overlay')
    const popout = nodeElement('alpha').querySelector('.popout-button')
    popout.focus()
    assert(document.activeElement === popout, 'pop-out cannot receive keyboard focus')
    // Smoke windows are unfocused, so WebKit does not apply :focus-within here.
    assert(popout.tabIndex === 0, 'pop-out is missing from keyboard navigation')
    assert(getComputedStyle(popout).visibility === 'visible', 'pop-out is excluded from tab order')
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
    await until('stale hint', () => query('.planner-stale'))
    const restartFetch = window.fetch
    const stopUrl = window.__TAURI_INTERNALS__.convertFileSrc('terminal_stop', 'ipc')
    let releaseStop
    const stopHeld = new Promise((resolve) => (releaseStop = resolve))
    window.fetch = async (input, options) => {
      const response = await restartFetch(input, options)
      if (String(input) === stopUrl && JSON.parse(options.body).sessionId === sid) await stopHeld
      return response
    }
    try {
      click(
        Array.from(document.querySelectorAll('.planner-terminal .tab-actions button')).find((b) =>
          b.textContent.includes('Restart'),
        ),
      )
      await until('planner exited during restart', () => state().sessions[sid]?.running === false)
      await until('restart progress label', () => {
        const button = document.querySelector('.planner-terminal .tab-actions button')
        return button?.disabled && button.textContent === '▶ Stopping…'
      })
    } finally {
      window.fetch = restartFetch
      releaseStop()
    }
    await until(
      'restarted planner',
      () => state().sessions[sid]?.running && state().planStartedWith[sid] === 'alpha',
    )
    await until('stale hint cleared', () => !query('.planner-stale'))
    await smoke.terminalWrite(sid, 'scrollback-$((6*7))\r')
    await until('scrollback marker', () => textOf(sid).includes('scrollback-'))
    // Exercise Claude's native hook payload before approval, without user settings or a real CLI.
    await smoke.terminalWrite(sid, 'handoff\r')
    await until('native plan captured', async () =>
      (await smoke.planRead(project.projectId)).text.includes('# Smoke handoff'),
    )
    // On the project folder, Implement asks where: a new worktree or the folder itself.
    click(
      Array.from(document.querySelectorAll('.plan-implement button')).find((b) =>
        b.textContent.includes('Implement'),
      ),
    )
    click(
      await until('implement target menu', () =>
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) =>
          b.textContent.includes('Implement in project folder'),
        ),
      ),
    )
    await until('implementation grid', () => query('.implementation-view .terminal-tile'))
    assert(
      query('.implementation-view .terminal-area').getBoundingClientRect().height > 100,
      'implementation terminal has no height',
    )
    assert(!query('.file-tree'), 'implementation has a file tree')
    await until('implementation agent', () => tiles('@task').length === 2)
    const agent = state().rootTerminals.find((t) => t.kind === 'agent')
    const agentSid = smoke.sessionId('@task', agent.id)
    await until('automatic plan handoff', () => textOf(agentSid).includes('# Smoke handoff'))
    await until('planner stopped after handoff', () => !state().sessions[sid]?.running)
    assert(!tiles('alpha').length, 'highlighting a component added its terminals to the task')
    assertScope(['alpha'])
    // A component's saved terminal joins the task through the Add terminal dialog, stopped.
    const openAddTerminal = async () => {
      click(query('button.add-task-terminal-button'))
      return until('add terminal dialog', () => query('form[aria-label="Add terminal"]'))
    }
    const addTerminal = async (target, key) => {
      const dialog = await openAddTerminal()
      choose(dialog.querySelector('select[aria-label="Where"]'), target)
      const terminal = dialog.querySelector('select[aria-label="Terminal"]')
      await until(`terminal choice ${key}`, () =>
        [...terminal.options].some((o) => o.value === key),
      )
      choose(terminal, key)
      await until('choice picked', () => terminal.value === key)
      click(query('form[aria-label="Add terminal"] button[type=submit]'))
      await until('dialog closed', () => !query('form[aria-label="Add terminal"]'))
    }
    const fetch = window.fetch
    const snapshotUrl = window.__TAURI_INTERNALS__.convertFileSrc('terminal_snapshot', 'ipc')
    let failedHydration = false
    window.fetch = (input, options) => {
      if (
        String(input) === snapshotUrl &&
        JSON.parse(options.body).sessionId === smoke.sessionId('alpha', 'task')
      ) {
        failedHydration = true
        return Promise.resolve(
          new Response('Smoke: saved output unavailable', {
            headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
          }),
        )
      }
      return fetch(input, options)
    }
    try {
      await addTerminal('alpha', 'saved\ntask')
      await until(
        'saved output load failed',
        () => failedHydration && state().message.includes('Smoke: saved output unavailable'),
      )
      const start = [...tiles('alpha')[0].querySelectorAll('button')].find((button) =>
        button.textContent.trim().startsWith('▶ Start'),
      )
      assert(start && !start.disabled, 'failed output loading made Start unreachable')
      assert(!tiles('alpha')[0].querySelector('.terminal-overlay button'), 'duplicate pane Start')
    } finally {
      window.fetch = fetch
      if (state().message.includes('Smoke: saved output unavailable')) state().setMessage('')
    }
    // Remount only the failed pane to retry hydration without a window-wide reconnect.
    click(tiles('alpha')[0].querySelector('button[aria-label="Remove Task"]'))
    await until('failed pane removed', () => !tiles('alpha').length)
    await addTerminal('alpha', 'saved\ntask')
    await until('saved output retry', () =>
      tiles('alpha')[0]?.querySelector('.terminal-overlay-command'),
    )
    await until('alpha terminal added', () => tiles('alpha').length === 1)
    // Anything running in the worktree shows too, so nothing it runs is out of sight.
    await smoke.startTerminal('unrelated', 'task')
    await until('background terminal visible', () => tiles('unrelated').length === 1)
    assertScope(['alpha'])
    assert(state().sessions[unrelatedTask]?.running, 'background terminal was stopped')
    const startButtons = [...tiles('alpha')[0].querySelectorAll('button')].filter((button) =>
      button.textContent.trim().startsWith('▶ Start'),
    )
    assert(startButtons.length === 1, 'terminal must offer exactly one Start action')
    assert(startButtons[0].closest('.terminal-tile-header'), 'Start must remain in the header')
    assert(
      tiles('alpha')[0].querySelector('.terminal-overlay-command')?.textContent === 'cat',
      'terminal command missing from overlay',
    )
    click(tiles('alpha')[0].querySelector('button[aria-label="Maximize Task"]'))
    await until('focused alpha', () => query('.terminal-tile.maximized'))
    click(query('.terminal-tile.maximized button[aria-label="Remove Task"]'))
    await until(
      'removed alpha restores others',
      () => !tiles('alpha').length && tiles('@task').length,
    )
    assert(!state().maximizedTerminal, 'removing left another terminal maximized')
    assert(state().sessions[unrelatedTask]?.running, 'removing stopped another process')
    assert(
      state()
        .nodes.find((n) => n.id === 'alpha')
        .data.terminals.some((t) => t.id === 'task'),
      'removing from the task removed the saved terminal',
    )
    // Highlights set what agents are briefed on, not which terminals the tab shows.
    state().toggleHighlight('beta')
    assertScope(['alpha', 'beta'])
    state().toggleHighlight('alpha')
    assertScope(['beta'])
    assert(!tiles('beta').length, 'highlighting added terminals')
    await addTerminal('beta', 'saved\ntask')
    await until('beta added', () => tiles('beta').length)
    click(viewButton('Plan'))
    await until('shared Plan scope', () => nodeElement('beta')?.querySelector('.highlighted'))
    assert(!nodeElement('alpha').querySelector('.highlighted'), 'filters lost shared Plan scope')
    click(viewButton('Build'))
    await until('returned task workspace', () => tiles('beta').length)
    assertScope(['beta'])
    state().select('beta')
    click(tiles('beta')[0].querySelector('button[aria-label="Maximize Task"]'))
    await until('component popout while maximized', () =>
      query('.terminal-tile.maximized .group-popout'),
    )
    click(query('button[aria-label="Restore Task"]'))
    await smoke.startTerminal('beta', 'task')
    await until(
      'beta task running',
      () => state().sessions[smoke.sessionId('beta', 'task')]?.running,
    )
    assert(state().sessions[smoke.sessionId('beta', 'task')].startedMs > 0, 'missing start time')
    smoke.stopTerminal(unrelatedTask)
    await until('background task stopped', () => !state().sessions[unrelatedTask]?.running)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '4', metaKey: true, bubbles: true }))
    await until('review shortcut', () => query('.review-view'))
    await until('review list', () => changesSettled('.review-view'))
    if (query('.review-view .change-list')) {
      await until('review diff', () => {
        const error = query('.review-view .diff-error')
        if (error) throw new Error(error.textContent)
        const view = query('.review-view .diff-view')
        return view && !view.classList.contains('diff-loading')
      })
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true }))
    await until('navigation shortcut', () => query('.navigation-shell .canvas'))
    await until('navigation viewport restored', () => viewport() === savedViewport)
    assert(state().selectedId === 'beta', 'selection is not shared with navigation')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }))
    await until('plan shortcut', () => query('.plan-dock'))
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
    await until(
      'implementation still on beta',
      () => tiles('beta')[0]?.querySelector('.terminal-tile-header strong')?.textContent === 'Task',
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
    state().setImplementationScope([
      { id: 'alpha', visible: false },
      ...state()
        .highlighted.filter((id) => id !== 'alpha')
        .map((id) => ({ id, visible: true })),
    ])
    assert(await smoke.removeComponents(['alpha']), 'component removal was refused')
    assert(
      !state().implementationComponents.some((c) => c.id === 'alpha'),
      'removed hidden pill was not pruned',
    )
    assert(!state().highlighted.includes('alpha'), 'removed highlight was not pruned')

    // Terminals added to a component are saved; agents there are told about their peers.
    state().setView('implementation')
    state().clearHighlights()
    state().toggleHighlight('beta')
    state().toggleHighlight('nearby')
    const dialog = await openAddTerminal()
    assert(
      dialog.querySelector('select[aria-label="Where"]').options[0].textContent === 'Project root',
      'Project root is not first in Add terminal',
    )
    assert(
      dialog.querySelector('button[type=submit]').textContent === 'Start agent',
      'Add terminal does not offer agents first',
    )
    click(dialog.querySelector('.row button[type=button]'))
    await until('dialog cancelled', () => !query('form[aria-label="Add terminal"]'))
    assert(!query('select[aria-label="Start agent"]'), 'Start agent select is still shown')
    const rootsBefore = state().rootTerminals.length
    await addTerminal('@task', 'custom')
    await until('root terminal added', () => state().rootTerminals.length === rootsBefore + 1)
    assert(state().rootTerminals.at(-1).kind === 'task', 'custom terminal has the wrong kind')
    const terminalsBefore = state().nodes.find((n) => n.id === 'beta').data.terminals.length
    state().addTerminal('beta', null)
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
    await until('briefing terminal stopped', () => !state().sessions[briefSid]?.running)
    // Removing a running terminal asks first, then stops it; the map keeps its configuration.
    await smoke.startTerminal('nearby', 'task')
    const nearbySid = smoke.sessionId('nearby', 'task')
    await until('nearby task running', () => state().sessions[nearbySid]?.running)
    await until('running nearby listed', () => tiles('nearby').length)
    const confirm = window.confirm
    const asked = []
    window.confirm = (message) => (asked.push(message), true)
    try {
      click(tiles('nearby')[0].querySelector('button[aria-label="Remove Task"]'))
    } finally {
      window.confirm = confirm
    }
    assert(asked.length === 1, 'removing a running terminal did not ask first')
    await until(
      'nearby stopped and gone',
      () => !state().sessions[nearbySid]?.running && !tiles('nearby').length,
    )
    assert(
      state()
        .nodes.find((n) => n.id === 'nearby')
        .data.terminals.some((t) => t.id === 'task'),
      'removing a terminal dropped its saved configuration',
    )
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
    state().toggleHighlight('beta')
    await until('beta scope before attention reveal', () => tiles('beta').length)
    click(query('.implementation-view button[aria-label^="Maximize"]'))
    await until('maximized before attention reveal', () => query('.terminal-tile.maximized'))
    smoke.selectPanel('activity')
    click(await until('attention item', () => query('.attention-item')))
    await until(
      'attention item reveals the agent',
      () =>
        state().view === 'implementation' &&
        state().selectedId === 'unrelated' &&
        state().activeSession === smoke.sessionId('unrelated', 'agent') &&
        query('.implementation-view .status-label.health-input'),
    )
    assertScope(['beta'])
    assert(state().highlighted.join() === 'beta', 'attention reveal changed shared scope')
    assert(!query('.terminal-tile.maximized'), 'attention reveal left another tile maximized')
    await until('running agent and server visible', () => tiles('unrelated').length === 2)
    smoke.stopTerminal(smoke.sessionId('unrelated', 'server'))
    await until('stopped server', () => {
      const server = state().sessions[smoke.sessionId('unrelated', 'server')]
      return server && !server.running && server.status?.stopped
    })
    // Background sessions are tiled only while they run; one still shown must read Stopped.
    const serverTile = tiles('unrelated').find((tile) => tile.textContent.includes('Server'))
    assert(
      !document.querySelector('.utility-panel .health-fail') &&
        (!serverTile ||
          (serverTile.classList.contains('health-idle') &&
            serverTile.querySelector('.status-dot')?.title.startsWith('Stopped'))),
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
    smoke.selectPanel('activity')
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
    // Check Navigation handoffs with the real fixture after the planner checks.
    const fixture = detected.components.find((c) => c.path === 'app')
    assert(fixture, 'missing fixture component')
    const navigationProject = {
      ...detected,
      components: [
        ...detected.components,
        ...Array.from({ length: 5 }, (_, i) => ({
          ...fixture,
          id: `filter-${i}`,
          name: `Filter ${i}`,
          path: '.',
          position: { x: (i + 1) * 320, y: 0 },
          terminals: [],
        })),
      ],
    }
    state().setView('navigation')
    state().syncProject(navigationProject)
    state().select(fixture.id)
    const inspectorTab = (name) =>
      [...document.querySelectorAll('.inspector .tabs button')].find(
        (button) => button.textContent === name,
      )
    click(await until('Files tab', () => inspectorTab('Files')))
    await until('fixture entries in Inspector', () => {
      const names = [...document.querySelectorAll('.inspector .file-tree-name')].map(
        (el) => el.textContent,
      )
      return names.includes('index.ts') && names.includes('package.json')
    })
    assert(!query('.hierarchy'), 'Navigation still shows the Hierarchy panel')
    const search = query('input[aria-label="Search files and commands"]')
    click(search)
    choose(search, 'filter 3')
    const found = await until('component search result', () =>
      [
        ...document.querySelectorAll(
          '.search-results [role="group"][aria-label="Components"] [role="option"]',
        ),
      ].find((option) => option.textContent.includes('Filter 3')),
    )
    click(found)
    await until('component focused from search', () => state().selectedId === 'filter-3')
    await until('Files tab reset', () => inspectorTab('Component')?.classList.contains('active'))
    click(search)
    choose(search, 'no such component')
    await until(
      'no component matches',
      () => query('.search-results') && !query('.search-results [aria-label="Components"]'),
    )
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    const context = (el) =>
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 120 }))
    const dismissMenu = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await until('context menu dismissed', () => !query('.node-menu-overlay'))
    }
    context(nodeElement(fixture.id).querySelector('.component-node'))
    const menu = await until('node actions menu', () => query('.node-extension-menu'))
    for (const label of ['Open in editor', 'Copy path', 'Open in window', 'Start Shell'])
      assert(menu.textContent.includes(label), `node menu missing ${label}`)
    assert(state().selectedId === fixture.id, 'context menu did not select the node')
    // Edit the runner's disposable fixture. A root change gives Review a second filter chip.
    const shell = fixture.terminals.find((t) => t.kind === 'shell')
    assert(shell, 'missing fixture shell')
    const fixtureSid = smoke.sessionId(fixture.id, shell.id)
    click(
      [...document.querySelectorAll('.node-extension-menu button')].find(
        (button) => button.textContent === `Start ${shell.name}`,
      ),
    )
    await until('fixture shell running', () => state().sessions[fixtureSid]?.running)
    assert(state().activeSession === fixtureSid, 'Start did not activate the terminal')
    context(nodeElement(fixture.id).querySelector('.component-node'))
    await until('Show terminal action', () =>
      [...document.querySelectorAll('.node-extension-menu button')].some(
        (button) => button.textContent === `Show ${shell.name}`,
      ),
    )
    await dismissMenu()
    await smoke.terminalWrite(
      fixtureSid,
      "printf '\\n' >> index.ts; printf navigation > ../navigation-smoke.txt\r",
    )
    await until('fixture changes badge', async () => {
      await smoke.requestGitRefresh()
      return nodeElement(fixture.id)?.querySelector('.changes-badge .git-badge')
    })
    state().select('filter-3')
    await until('selection before badge', () => state().selectedId === 'filter-3')
    click(nodeElement(fixture.id).querySelector('.changes-badge .git-badge'))
    await until('changed fixture in popover', () =>
      query('.changes-popover .change-row[title$="app/index.ts"]'),
    )
    assert(state().selectedId === 'filter-3', 'changes badge changed selection')
    click(query('.changes-popover-footer'))
    await until(
      'Review component filter active',
      () =>
        state().view === 'review' &&
        [...document.querySelectorAll('.review-filter .filter-chip.on')].some((chip) =>
          chip.textContent.includes(fixture.name),
        ),
    )
    assert(state().reviewFocus === null, 'Review did not consume the one-shot focus')
    await smoke.terminalWrite(
      fixtureSid,
      'git restore -- index.ts; rm -f ../navigation-smoke.txt\r',
    )
    await until('fixture restored', async () => {
      await smoke.requestGitRefresh()
      return !state().gitChanges[fixture.id]
    })
    smoke.stopTerminal(fixtureSid)
    await until('fixture shell stopped', () => !state().sessions[fixtureSid]?.running)
    state().setView('navigation')
    state().select(null)
    state().setActiveSession(null)
    smoke.store.setState({ inspector: null })
    await smoke.report(
      'PASS views: navigation actions, inspector files, component search, changes handoff, scope, context, restart, scrollback, shortcuts, implementation, changes, review, merge selection, status, workspace continuity, multi-component implementation, peers',
    )
  } catch (e) {
    await smoke.report(`FAIL views: ${e?.message ?? e} ${e?.stack ?? ''}`)
  }
})()
