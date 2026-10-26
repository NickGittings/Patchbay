// Map/chat workflow against real PTYs, saved artifacts and the session service. Focused-window
// authority and native permission UI remain manual checks, as with all background smoke runs.
;(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (label, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const button = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const click = (el) => {
    assert(el, 'missing click target')
    el.click()
  }
  const toggleSimple = async () =>
    click(document.querySelector('.workspace-rail [aria-label="Chat mode"]'))
  const input = (el, value) => {
    assert(el, 'missing input')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const send = async (text) => {
    input(document.querySelector('[aria-label="Message agent"]'), text)
    await until('Send enabled', () => !button('Send')?.disabled)
    click(button('Send'))
  }
  try {
    smoke.acceptOpened(await smoke.openProject())
    const projectId = state().project.id
    const parent = state().project.root.replace(/\/project$/, '')
    state().setDevices([
      {
        id: 'simple-agent',
        name: 'Simple agent',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
        adapter: 'codex',
        command: `python3 '${parent}/agent.py'`,
      },
      {
        id: 'unhooked-agent',
        name: 'Unhooked agent',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
        // The launcher's private homes leave Claude without hooks; Codex's are installed below.
        adapter: 'claude',
        command: `'${parent}/claude'`,
      },
      {
        id: 'reporting-claude',
        name: 'Reporting Claude',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
        // Reports through its session's journal although the app finds no Claude hooks, as when
        // a shell profile points Claude at another configuration.
        adapter: 'claude',
        command: `python3 '${parent}/agent.py'`,
      },
    ])
    await smoke.syncCurrentRoots()
    await smoke.refreshTasks()
    const task = await smoke.taskAttach(`${parent}/feature`, 'Simple feature', ['app'])
    await smoke.refreshTasks()
    state().setActiveTask(task.id, true)
    assert(!state().simpleMode, 'Simple must default off')
    // Navigation first exercises opening Chat before it has a saved layout.
    for (const previous of ['navigation', 'plan', 'implementation', 'review']) {
      state().setView(previous)
      await until(`Full ${previous}`, () => !document.querySelector('.simple-chat'))
      state().setSimpleMode(true)
      await until(`Simple from ${previous}`, () => document.querySelector('.simple-chat'))
      assert(
        !document.querySelector('.react-flow__node.draggable'),
        `Simple from ${previous} allows dragging`,
      )
      assert(
        !document.querySelector('.react-flow__controls-interactive'),
        `Simple from ${previous} allows editing`,
      )
      state().clearHighlights()
      const id = state().nodes[0].id
      click(
        await until('Simple component', () =>
          document.querySelector(`.react-flow__node[data-id="${id}"]`),
        ),
      )
      await until(`highlight from ${previous}`, () => state().highlighted.includes(id))
      state().setSimpleMode(false)
      await until(`leave Simple for ${previous}`, () => !document.querySelector('.simple-chat'))
      if (previous === 'navigation')
        await until('canvas reclaims hidden panels', () => {
          const chat = document.getElementById('App-simple-chat')
          const inspector = document.getElementById('App-pane-5')
          return (
            chat?.getBoundingClientRect().width === 0 &&
            (!document.querySelector('.inspector-toggle') ||
              inspector?.getBoundingClientRect().width === 0)
          )
        })
      if (previous !== 'navigation')
        assert(
          !document.querySelector('.navigation-shell'),
          `Navigation mounted behind ${previous}`,
        )
    }
    state().setView('review')
    await toggleSimple()
    await until('chat', () => document.querySelector('.simple-chat'))
    // The fake agents journal hook events themselves; the notices follow installed hooks.
    const activityNotice = await until('activity hooks notice', () =>
      document.querySelector('.simple-chat > .simple-hook-notice'),
    )
    click(button('Set up…', activityNotice))
    const setup = await until('Agent status integration dialog', () =>
      document.querySelector('[role="dialog"][aria-label="Agent status integration"]'),
    )
    const provider = setup.querySelector('select')
    // The notice is about the role presets' provider, so the dialog opens on Codex.
    await until(
      'Codex integration check',
      () => !provider.disabled && setup.textContent.includes('Hooks not installed'),
    )
    assert(provider.value === 'codex', `integrations opened on ${provider.value}, not Codex`)
    click(button('Install status hooks', setup))
    state().setSimpleMode(false)
    await until('Full while installing hooks', () => !document.querySelector('.simple-chat'))
    assert(setup.isConnected, 'leaving Chat closed the integrations dialog')
    state().setSimpleMode(true)
    await until('Chat while installing hooks', () => document.querySelector('.simple-chat'))
    assert(
      document.querySelectorAll('[role="dialog"][aria-label="Agent status integration"]').length ===
        1,
      'multiple integrations dialogs opened',
    )
    await until('Codex hooks installed', () => setup.textContent.includes('Hooks installed'))
    click(setup.querySelector('[aria-label="Close Agent status integration"]'))
    await until(
      'activity hooks notice cleared',
      () => !document.querySelector('.simple-hook-notice'),
    )
    assert(state().view === 'review', 'Simple lost the last Full view')
    assert(
      document.querySelectorAll('.workspace-rail > button').length === 11,
      'rail controls missing',
    )
    assert(
      document
        .querySelector('.workspace-rail [aria-label="Chat mode"]')
        .getAttribute('aria-pressed') === 'true',
      'Chat toggle selection missing',
    )
    assert(document.querySelector('.current-stage-dot'), 'current stage indicator missing')
    const stageTab = (name) =>
      [...document.querySelectorAll('.simple-stage-tabs button')].find((b) =>
        b.textContent.startsWith(name),
      )
    const stageToggle = (name) =>
      [...document.querySelectorAll('.simple-stage > h2 > button')].find((b) =>
        b.textContent.trim().endsWith(name),
      )
    const stageContent = (name) =>
      document.getElementById(stageToggle(name)?.getAttribute('aria-controls'))
    const expectOpenStages = (names) =>
      until(`expanded stages: ${names.join(', ')}`, () =>
        ['Plan', 'Build', 'Review', 'Merge'].every((name) => {
          const toggle = stageToggle(name)
          const content = stageContent(name)
          return (
            toggle &&
            content &&
            (toggle.getAttribute('aria-expanded') === 'true') === names.includes(name) &&
            content.hidden !== names.includes(name)
          )
        }),
      )
    for (const modifier of ['metaKey', 'ctrlKey']) {
      for (const [i, name] of ['All', 'Plan', 'Build', 'Review'].entries()) {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: String(i + 1), [modifier]: true, bubbles: true }),
        )
        if (i > 0) {
          await until(`${modifier}+${i + 1} restores Full`, () => !state().simpleMode)
          assert(state().view === 'review', 'Chat shortcut lost the last Full view')
          state().setSimpleMode(true)
          await until('Chat after shortcut', () => document.querySelector('.simple-chat'))
        }
        click(
          document.querySelector(
            `.workspace-rail [aria-label="${name === 'All' ? 'Navigation' : name}"]`,
          ),
        )
        await until(
          `${name} rail stage filter`,
          () => stageTab(name).getAttribute('aria-pressed') === 'true',
        )
        assert(
          state().simpleMode && state().view === 'review',
          'rail stage filter changed mode or Full view',
        )
        assert(document.querySelector('.simple-chat'), 'rail stage filter closed Chat')
        const railLabel = name === 'All' ? 'Navigation' : name
        assert(
          document
            .querySelector(`.workspace-rail [aria-label="${railLabel}"]`)
            .getAttribute('aria-pressed') === 'true',
          `${name} rail highlight missing`,
        )
      }
    }
    click(stageTab('Review'))
    await until('Review stage filter', () => {
      const shown = [...document.querySelectorAll('.simple-stage > h2')].map((h) => h.textContent)
      return shown.join(',') === 'Review'
    })
    click(stageTab('Merge'))
    await until('Merge stage filter', () => {
      const shown = [...document.querySelectorAll('.simple-stage > h2')].map((h) => h.textContent)
      return shown.join(',') === 'Merge'
    })
    click(stageTab('All'))
    await until('every stage shown', () => document.querySelectorAll('.simple-stage').length === 4)
    await expectOpenStages(['Plan'])
    // Empty startup can briefly project Plan before restored action history arrives. Neither
    // that provisional stage nor later review/fix rounds should become a disclosure choice.
    const beforeRestore = state().simple
    try {
      for (const [i, action] of ['implement', 'review', 'fix', 'review', 'merge'].entries()) {
        const stage = action === 'review' ? 'review' : action === 'merge' ? 'merge' : 'build'
        state().patchTask(projectId, task.id, {
          simple: {
            ...beforeRestore,
            log: [{ id: `restore-${i}`, atMs: Date.now(), kind: 'action', action, stage }],
          },
        })
        await expectOpenStages([stage[0].toUpperCase() + stage.slice(1)])
      }
    } finally {
      state().patchTask(projectId, task.id, { simple: beforeRestore })
    }
    await expectOpenStages(['Plan'])
    const buildContent = stageContent('Build')
    stageToggle('Build').focus()
    assert(document.activeElement === stageToggle('Build'), 'stage toggle cannot receive focus')
    await expectOpenStages(['Plan'])
    click(stageToggle('Build'))
    click(stageToggle('Review'))
    await expectOpenStages(['Plan', 'Build', 'Review'])
    click(stageToggle('Build'))
    await expectOpenStages(['Plan', 'Review'])
    assert(stageContent('Build') === buildContent, 'collapsing a stage remounted its content')
    click(stageToggle('Plan'))
    await expectOpenStages(['Review'])
    click(stageTab('Build'))
    await until('individual Build expanded', () => {
      const section = document.querySelector('.simple-stage')
      return (
        section?.querySelector('h2')?.textContent === 'Build' &&
        !section.querySelector(':scope > div').hidden
      )
    })
    // The user's choices outlast filters, including explicit choices matching the defaults.
    click(stageTab('All'))
    await expectOpenStages(['Review'])
    click(stageToggle('Review'))
    click(stageToggle('Plan'))
    await expectOpenStages(['Plan'])
    const canvas = document.querySelector('.navigation-shell .react-flow')
    assert(canvas, 'map missing')
    await send('  hello mail@example.test\nsecond line  ')
    await until('first delivered prompt', () =>
      state().simple?.log.some((e) => e.kind === 'prompt'),
    )
    const prompt = state().simple.log.find((e) => e.kind === 'prompt')
    assert(prompt.text === '  hello mail@example.test\nsecond line  ', 'prompt text was rewritten')
    const planner = prompt.sessionId
    await until('hooked planner', () => state().sessions[planner]?.status?.agent?.authoritative)
    input(document.querySelector('[aria-label="Message agent"]'), 'hook notice draft')
    await until(
      'hook notice draft',
      () => document.querySelector('[aria-label="Message agent"]')?.value === 'hook notice draft',
    )
    assert(!document.querySelector('.simple-hook-notice'), 'hooked agent shows a hooks notice')
    await smoke.terminalWrite(planner, 'smoke-wait\n')
    await until(
      'planner working',
      () => state().sessions[planner]?.status?.agent?.state === 'working',
    )
    await smoke.terminalWrite(planner, '\u001b')
    await until(
      'Esc invalidates prompt authority',
      () => state().sessions[planner]?.status?.agent?.authoritative === false,
    )
    assert(!document.querySelector('.simple-hook-notice'), 'Esc shows a missing hooks notice')
    const escLabel = document.querySelector('.simple-composer-controls').textContent
    assert(!escLabel.includes('Chat needs'), 'Esc claims installed hooks are missing')
    assert(escLabel.includes('continue in its terminal'), `Esc label: ${escLabel}`)
    await smoke.startTerminal('@plan', 'unhooked-agent', null, projectId)
    const unhooked = await until('unhooked planner', () =>
      state().sessionRecords.find((r) => r.metadata.terminalId === 'unhooked-agent'),
    )
    await until('unhooked planner running', () => state().sessions[unhooked.id]?.running)
    const chooseRecipient = (value) => {
      const select = document.querySelector('[aria-label="Message recipient"]')
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    try {
      chooseRecipient(unhooked.id)
      await until('unhooked agent notice', () =>
        document.querySelector('.simple-composer .simple-hook-notice'),
      )
      assert(
        document.querySelector('.simple-chat > .simple-hook-notice'),
        'unhooked agent shows no activity hooks notice',
      )
      await smoke.terminalStop(unhooked.id)
      await until('unhooked planner stopped', () => !state().sessions[unhooked.id]?.running)
      // A stopped recipient without hooks is refused before anything resumes it.
      input(document.querySelector('[aria-label="Message agent"]'), 'unhooked draft')
      const stoppedNotice = await until('stopped unhooked agent notice', () =>
        document.querySelector('.simple-composer .simple-hook-notice'),
      )
      assert(button('Send').disabled, 'Send enabled for an agent without hooks')
      assert(
        document
          .querySelector('.simple-composer-controls')
          .textContent.includes('Chat needs agent status integration'),
        'stopped unhooked agent label',
      )
      document
        .querySelector('[aria-label="Message agent"]')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 1000))
      assert(!state().sessions[unhooked.id]?.running, 'Send resumed an agent without hooks')
      assert(
        document.querySelector('[aria-label="Message agent"]').value === 'unhooked draft',
        'refused send cleared the draft',
      )
      click(button('Set up…', stoppedNotice))
      const integrations = await until('Agent status integration dialog', () =>
        document.querySelector('[role="dialog"][aria-label="Agent status integration"]'),
      )
      assert(
        integrations.querySelector('select').value === 'claude',
        'integrations did not open on Claude',
      )
      click(integrations.closest('.extension-overlay'))
      input(document.querySelector('[aria-label="Message agent"]'), '   ')
      await until(
        'blank draft hides hooks notice',
        () => !document.querySelector('.simple-composer .simple-hook-notice'),
      )
    } finally {
      await smoke.terminalStop(unhooked.id)
      await until('unhooked planner stopped', () => !state().sessions[unhooked.id]?.running)
      await smoke.sessionForget(unhooked.id)
      await until('unhooked planner forgotten', async () => {
        await smoke.reconcileSessions()
        return !state().sessionRecords.some((r) => r.id === unhooked.id)
      })
      chooseRecipient('')
      input(document.querySelector('[aria-label="Message agent"]'), '')
    }
    await smoke.startTerminal('@plan', 'reporting-claude', null, projectId)
    const reporting = await until('reporting Claude planner', () =>
      state().sessionRecords.find((r) => r.metadata.terminalId === 'reporting-claude'),
    )
    try {
      await until(
        'reporting Claude ready',
        () =>
          state().sessions[reporting.id]?.status?.agent?.authoritative &&
          state().sessions[reporting.id]?.status?.agent?.state === 'idle',
      )
      chooseRecipient(reporting.id)
      input(document.querySelector('[aria-label="Message agent"]'), 'reporting draft')
      // Claude's hooks are missing from the app's view, yet a hook-confirmed prompt is sendable.
      await until('Send enabled for a reporting agent', () => !button('Send')?.disabled)
      const label = document.querySelector('.simple-composer-controls').textContent
      assert(label.includes('Ready'), `reporting agent label: ${label}`)
      assert(!document.querySelector('.simple-hook-notice'), 'reporting agent shows a hooks notice')
      await smoke.terminalWrite(reporting.id, 'smoke-wait\n')
      await until(
        'custom-config agent working',
        () => state().sessions[reporting.id]?.status?.agent?.state === 'working',
      )
      await smoke.terminalWrite(reporting.id, '\u001b')
      await until(
        'custom-config Esc revokes readiness',
        () => state().sessions[reporting.id]?.status?.agent?.authoritative === false,
      )
      assert(
        !document.querySelector('.simple-hook-notice'),
        'Esc forgot custom-config hook evidence',
      )
      assert(button('Send').disabled, 'Esc left the custom-config prompt sendable')
      assert(
        document
          .querySelector('.simple-composer-controls')
          .textContent.includes('continue in its terminal'),
        'custom-config Esc asks to install hooks',
      )
    } finally {
      await smoke.terminalStop(reporting.id)
      await until('reporting planner stopped', () => !state().sessions[reporting.id]?.running)
      await smoke.sessionForget(reporting.id)
      await until('reporting planner forgotten', async () => {
        await smoke.reconcileSessions()
        return !state().sessionRecords.some((r) => r.id === reporting.id)
      })
      chooseRecipient('')
      input(document.querySelector('[aria-label="Message agent"]'), '')
    }
    await until('saved plan card', () => button('Implement') && !button('Implement').disabled)
    click(stageToggle('Build'))
    click(stageToggle('Review'))
    click(stageToggle('Merge'))
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    const focusedPlanControl = stageContent('Plan').querySelector('.simple-agent header button')
    focusedPlanControl.focus()
    await until('Plan control focused', () => document.activeElement === focusedPlanControl)
    click(button('Implement'))
    await until('Implement completion', () =>
      state().simple?.log.some((e) => e.action === 'implement'),
    )
    assert(state().simpleMode, 'Implement left Simple')
    // Advancing retains the open Plan independently of focus and inline card state.
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    assert(document.activeElement === focusedPlanControl, 'stage advance lost keyboard focus')
    const buildControl = button('Review…')
    const controlTop = buildControl.getBoundingClientRect().top
    buildControl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    buildControl.focus()
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    assert(buildControl.getBoundingClientRect().top === controlTop, 'blur moved the click target')
    buildControl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    click(buildControl)
    const blurDialog = await until('Build click after stage advance', () =>
      document.querySelector('form[aria-label="Start review agent"]'),
    )
    click(button('Cancel', blurDialog))
    const planAgentToggle = stageContent('Plan').querySelector('.simple-agent header button')
    click(planAgentToggle)
    await until('Plan card opened', () => planAgentToggle.getAttribute('aria-expanded') === 'true')
    click(planAgentToggle)
    await until('Plan card closed', () => planAgentToggle.getAttribute('aria-expanded') === 'false')
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    stageToggle('Plan').focus()
    click(stageToggle('Plan'))
    click(stageToggle('Plan'))
    document.querySelector('[aria-label="Message agent"]').focus()
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    // Removing the focused section must not leave behind a reason to keep it open.
    planAgentToggle.focus()
    click(stageTab('Merge'))
    await until('focused Plan removed by filter', () => !planAgentToggle.isConnected)
    click(stageTab('All'))
    await expectOpenStages(['Plan', 'Build', 'Review', 'Merge'])
    click(stageToggle('Plan'))
    click(stageToggle('Review'))
    click(stageToggle('Merge'))
    await expectOpenStages(['Build'])
    const implementation = state().simple.log.find((e) => e.action === 'implement').sessionId
    // Implement stops its planner. A new shared planning run must still surface input in Build.
    const plannerGeneration = state().sessions[planner].generation
    await smoke.startTerminal('@plan', 'simple-agent', null, projectId)
    try {
      await until(
        'new shared planner ready',
        () =>
          state().sessions[planner]?.generation > plannerGeneration &&
          state().sessions[planner]?.status?.agent?.authoritative,
      )
      await smoke.terminalWrite(planner, 'smoke-input\n')
      await until(
        'planner needs input',
        () => state().sessions[planner]?.status?.agent?.state === 'needsInput',
      )
      await expectOpenStages(['Plan', 'Build'])
      const planToggle = stageToggle('Plan')
      assert(planToggle.getAttribute('aria-disabled') === 'true', 'asking stage can be collapsed')
      planToggle.focus()
      click(planToggle)
      await expectOpenStages(['Plan', 'Build'])
      assert(document.activeElement === planToggle, 'asking stage toggle lost focus')
      const askingAgent = document.querySelector(`.simple-agent[data-session="${planner}"]`)
      assert(askingAgent.getClientRects().length, 'agent awaiting input is hidden')
      assert(
        askingAgent.querySelector('header button').getAttribute('aria-expanded') === 'true',
        'input did not open terminal',
      )
      click(stageTab('Merge'))
      await until('input request survives stage filter', () => {
        const shown = [...document.querySelectorAll('.simple-stage > h2')].map((h) => h.textContent)
        return shown.join(',') === 'Plan,Merge' && askingAgent.getClientRects().length
      })
      askingAgent.querySelector('.simple-terminal').scrollIntoView({ block: 'center' })
      // Background smoke windows don't intersect the screen, so observe the container that
      // owns the lazy TerminalPane mount instead of waiting for xterm's viewport observer.
      const terminal = askingAgent.querySelector('.simple-terminal')
      assert(terminal, 'input terminal container missing')
      const thread = document.querySelector('.simple-thread')
      const beforeAnswer = thread.scrollTop
      await smoke.terminalWrite(planner, 's')
      await until(
        'first answer letter revokes input status',
        () =>
          state().sessions[planner]?.status?.agent?.state === 'working' &&
          !askingAgent.hasAttribute('data-needs-input'),
      )
      assert(askingAgent.getClientRects().length, 'partial answer hid its filtered stage')
      assert(terminal.isConnected, 'first answer letter unmounted the terminal')
      assert(thread.scrollTop === beforeAnswer, 'first answer letter moved the chat scroll')
      click(stageTab('All'))
      await expectOpenStages(['Plan', 'Build'])
      for (const char of 'moke-wait') {
        await smoke.terminalWrite(planner, char)
        await sleep(50)
        assert(terminal.isConnected, 'typing an answer unmounted the terminal')
        assert(askingAgent.getClientRects().length, 'typing an answer hid its stage')
      }
      await smoke.terminalWrite(planner, '\n')
      await until(
        'planner input resolved',
        () =>
          state().sessions[planner]?.status?.agent?.state === 'working' &&
          state().sessions[planner]?.status?.agent?.authoritative,
      )
      assert(
        smoke.terminalText(planner).text.includes("simple-received:'smoke-wait\\n'"),
        'partial answer text was lost',
      )
      // Only provider confirmation ends automatic expansion, preserving the user's choices.
      const agentToggle = askingAgent.querySelector('header button')
      await until(
        'resolved input card collapses',
        () => agentToggle.getAttribute('aria-expanded') === 'false',
      )
      await expectOpenStages(['Build'])
      // A folded stage still says what its agents are doing.
      await until('folded Plan shows its working agent', () =>
        stageToggle('Plan')
          ?.parentElement.querySelector('.status-label')
          ?.textContent.includes('Working'),
      )
      const foldedChip = stageToggle('Plan').parentElement.querySelector('.status-label')
      const previousTitle = foldedChip.title
      await until('folded tooltip age refreshes', () => foldedChip.title !== previousTitle)
      // Stop while the last report still asks, then remount that card through a stage filter.
      await smoke.terminalWrite(planner, 'smoke-input\n')
      await until('planner asks again', () => askingAgent.hasAttribute('data-needs-input'))
    } finally {
      await smoke.terminalStop(planner)
      await until('shared planner stopped', () => !state().sessions[planner]?.running)
    }
    // Stopping clears automatic input expansion even when the last hook report still asks.
    const stoppedAgent = document.querySelector(`.simple-agent[data-session="${planner}"]`)
    await until('stopped card no longer asks', () => !stoppedAgent.hasAttribute('data-needs-input'))
    assert(
      stoppedAgent.querySelector('header button').getAttribute('aria-expanded') === 'false',
      'stopped input left its card expanded',
    )
    await expectOpenStages(['Build'])
    click(stageTab('Merge'))
    await until('stopped input stays out of Merge filter', () =>
      [...document.querySelectorAll('.simple-stage > h2')].every((h) => h.textContent === 'Merge'),
    )
    click(stageTab('Plan'))
    await until('stopped card remounted without auto-expanding', () => {
      const agent = document.querySelector(`.simple-agent[data-session="${planner}"]`)
      return (
        agent &&
        !agent.hasAttribute('data-needs-input') &&
        agent.querySelector('header button').getAttribute('aria-expanded') === 'false'
      )
    })
    click(stageTab('All'))
    await expectOpenStages(['Build'])
    await until('activity hydration', () => state().sessions[implementation]?.activity?.length)
    await until('Build agent chip on the map', () =>
      document.querySelector('.navigation-shell .component-node .agent-role.build'),
    )
    await until('file card', () => document.querySelector('.simple-file'))
    click(document.querySelector('.simple-file'))
    await until('left diff', () => document.querySelector('.simple-diff .diff'))
    assert(document.querySelector('.navigation-shell .react-flow') === canvas, 'diff remounted map')
    click(button('← Map'))
    await until('map restored', () => !document.querySelector('.simple-diff'))
    click(stageToggle('Review'))
    click(button('Review…'))
    const review = await until('review dialog', () =>
      document.querySelector('form[aria-label="Start review agent"]'),
    )
    await until('review ready', () => !review.querySelector('button[type="submit"]').disabled)
    review.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await until('review dispatch logged', () =>
      state().simple?.log.some((e) => e.action === 'review'),
    )
    await expectOpenStages(['Build', 'Review'])
    await until(
      'Findings Fix enabled',
      () => button('Fix findings') && !button('Fix findings').disabled,
    )
    click(button('Fix findings'))
    await until('fix dispatch', () => state().simple?.log.some((e) => e.action === 'fix'))
    await expectOpenStages(['Build', 'Review'])
    const fix = state().simple.log.find((e) => e.action === 'fix').sessionId
    assert(state().simpleMode, 'Fix left Simple')
    click(stageToggle('Review'))
    await expectOpenStages(['Build'])
    click(stageToggle('Review'))
    await expectOpenStages(['Build', 'Review'])
    input(document.querySelector('[aria-label="Message agent"]'), 'worktree draft')
    state().setActiveTask(null, true)
    await until(
      'project chat',
      () => document.querySelector('[aria-label="Message agent"]')?.value === '',
    )
    assert(!state().simple?.log.length, 'worktree history leaked to project chat')
    await expectOpenStages(['Plan'])
    state().setActiveTask(task.id, true)
    await until(
      'draft restored',
      () => document.querySelector('[aria-label="Message agent"]')?.value === 'worktree draft',
    )
    // Stage choices are kept per worktree, like the draft, across the chat's remount.
    await expectOpenStages(['Build', 'Review'])
    assert(
      state().simple.log.some((e) => e.sessionId === implementation),
      'history lost on worktree switch',
    )
    await toggleSimple()
    await until('Full review restored', () => document.querySelector('.review-view'))
    assert(state().view === 'review', 'last Full view was not restored')
    state().setSimpleMode(true)
    await until('chat again', () => document.querySelector('.simple-chat'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))
    await until('Full review restored after shortcut', () => document.querySelector('.review-view'))
    assert(!state().simpleMode, 'Chat shortcut did not return to Full')
    assert(state().view === 'review', 'Chat shortcut changed the last full workspace view')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '3', metaKey: true, bubbles: true }))
    await until('Full Build shortcut', () => state().view === 'implementation')
    await until('same fix terminal in Full', () =>
      document.querySelector(`.terminal-tile[data-session="${fix}"] .xterm-host`),
    )
    const records = await smoke.sessionsList()
    assert(
      records.some((r) => r.id === planner),
      'planner session disappeared',
    )
    assert(
      records.some((r) => r.id === implementation),
      'implementation session disappeared',
    )
    assert(
      records.some((r) => r.id === fix),
      'fix session disappeared',
    )
    const saved = smoke.workspaceDocument().projects.find((p) => p.id === projectId).layout
    assert(
      saved.taskWorkspaces[task.id].simple.log.some((e) => e.sessionId === fix),
      'log was not persisted',
    )
    await smoke.report(
      'PASS simple: toggle, stage disclosures and input requests, composer, Implement, diff, Review/Fix, activity, role chips, worktree drafts, and Full session recovery',
    )
  } catch (e) {
    await smoke.report(
      `FAIL simple: ${e.message} ${e.stack || ''} visibility=${document.visibilityState} plan=${JSON.stringify(await smoke.planRead(state().project.id))} chat=${document.querySelector('.simple-chat')?.innerText.slice(0, 1000)}`,
    )
  }
})()
