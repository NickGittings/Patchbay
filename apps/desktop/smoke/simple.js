// A single conversation through planning, a new worktree, review, fixes and merge.
;(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (label, check, timeout = 25000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      // Let React commit store and panel updates before reading the next UI state.
      await sleep(16)
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (value, text) => {
    if (!value) throw new Error(text)
  }
  const button = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const click = (el) => {
    assert(el, 'missing click target')
    const details = el.closest('details')
    if (details && !details.open && el !== details.querySelector('summary'))
      details.querySelector('summary').click()
    el.click()
  }
  const input = (el, value) => {
    assert(el, 'missing input')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const chatText = () => document.querySelector('.simple-thread')?.textContent ?? ''
  const inChat = () => assert(state().simpleMode && state().view === 'navigation', 'flow left Chat')
  try {
    await smoke.resizeWindow(1440, 900)
    smoke.acceptOpened(await smoke.openProject())
    const projectId = state().project.id
    const parent = state().project.root.replace(/\/project$/, '')
    const fake = {
      id: 'simple-agent',
      name: 'Simple agent',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      adapter: 'codex',
      command: `'${parent}/codex'`,
    }
    state().setDevices([fake])
    state().setAgentRoles({
      plan: [fake.id],
      implement: [fake.id],
      review: [fake.id],
      fix: [fake.id],
      merge: [fake.id],
    })
    await smoke.agentHooksConfigure('codex', true)
    await smoke.syncCurrentRoots()
    state().setSimpleMode(true)
    await until('root chat before worktree creation', () => document.querySelector('.simple-chat'))
    click(
      await until('review options before planning', () =>
        document.querySelector('.simple-chat [aria-label="Review options"]:not(:disabled)'),
      ),
    )
    const reviewOptions = await until('review base picker before planning', () =>
      document.querySelector('form[aria-label="Review"]'),
    )
    assert(reviewOptions.querySelector('[aria-label="Base branch"]'), 'missing review base picker')
    assert(reviewOptions.textContent.includes('Agents: Simple agent'), 'default agent is hidden')
    assert(!reviewOptions.querySelector('[aria-label="Agent"]'), 'agent picker should start closed')
    assert(!reviewOptions.querySelector('code'), 'compact review shows the source path')
    click(button('Change', reviewOptions))
    await until('review agent picker expanded', () =>
      reviewOptions.querySelector('[aria-label="Agent"]'),
    )
    click(button('Done', reviewOptions))
    await until(
      'review agent picker collapsed',
      () => !reviewOptions.querySelector('[aria-label="Agent"]'),
    )
    assert(reviewOptions.textContent.includes('Agents: Simple agent'), 'agent summary disappeared')
    click(button('Cancel', reviewOptions))
    await until('review options closed', () => !document.querySelector('[role="dialog"]'))
    await until('root chat layout saved', () => smoke.chatPanel.width() > 0)
    const initialRootChatWidth = smoke.chatPanel.width()
    const initialRootLayout = { ...state().panels['App-simple'] }
    await smoke.createTask({
      title: 'Simple chat build',
      branch: 'simple-chat-build',
      components: ['app'],
    })
    state().setSimpleMode(true)
    if (!state().panels['App-simple']) state().setPanelLayout('App-simple', initialRootLayout)
    state().revealChat({ projectId, task: state().activeTask })
    await until('chat', () => document.querySelector('.simple-chat'))
    // Chat's resize handle must receive pointer hits even while Inspector is hidden.
    const { width: chatWidth, drag: dragChat } = smoke.chatPanel
    await until('chat width saved', () => chatWidth() > 0)
    assert(!document.querySelector('.simple-stage-tabs'), 'stage tabs remain')
    assert(!document.querySelector('.simple-terminal-drawer'), 'terminal starts open')
    assert(
      document
        .querySelector('.workspace-rail [aria-label="Navigation"]')
        .getAttribute('aria-pressed') === 'false',
      'Full Navigation is pressed in Chat',
    )
    // Planning is an existing workspace session; Chat must explicitly select its recipient.
    await smoke.startTerminal('@plan', fake.id, state().activeTask, projectId)
    const plannerRecord = await until('planner available in picker', () =>
      state().sessionRecords.find(
        (r) => r.metadata.componentId === '@plan' && r.metadata.terminalId === fake.id,
      ),
    )
    const chooser = await until('chat agent picker', () =>
      document.querySelector('[aria-label="Chat agent"]:not(:disabled)'),
    )
    assert(chooser.value === '', 'new chat silently selected an agent')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(chooser), 'value').set.call(
      chooser,
      `session:${plannerRecord.id}`,
    )
    chooser.dispatchEvent(new Event('change', { bubbles: true }))
    await until(
      'planner explicitly selected',
      () => state().simple?.selectedAgent === plannerRecord.id,
    )
    const composer = document.querySelector('[aria-label="Message agent"]')
    for (const options of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...options,
      })
      composer.dispatchEvent(enter)
      assert(!enter.defaultPrevented, 'newline or IME Enter was captured by Send')
    }
    input(composer, 'Plan the fixture feature @a')
    await until('mention options', () => document.querySelector('.simple-composer [role="option"]'))
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await until('Enter selects mention', () => composer.value === 'Plan the fixture feature @app')
    assert(!state().simple?.log.some((e) => e.kind === 'prompt'), 'mention Enter sent a prompt')
    await until(
      'completed mention closes autocomplete',
      () => !document.querySelector('.simple-composer [role="option"]'),
    )
    await until('Send ready', () => {
      const b = button('Start') ?? button('Send')
      return b && !b.disabled
    })
    composer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    const firstPrompt = await until('planner working', () => {
      const entry = state().simple?.log.find((e) => e.kind === 'prompt')
      return entry && state().sessions[entry.sessionId]?.status?.agent?.state === 'working' && entry
    })
    assert(firstPrompt.mentions.includes('app'), 'consecutive Enter lost mention scope')
    input(document.querySelector('[aria-label="Message agent"]'), 'Queued fixture follow-up @a')
    await until('queue mention options', () =>
      document.querySelector('.simple-composer [role="option"]'),
    )
    await until('Queue primary action', () => button('Queue') && !button('Queue').disabled)
    let queuedShown = false
    const queueObserver = new MutationObserver(() => {
      queuedShown ||= !!document.querySelector('.simple-queued')
    })
    queueObserver.observe(document.querySelector('.simple-composer'), {
      childList: true,
      subtree: true,
    })
    document
      .querySelector('[aria-label="Message agent"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    await until('Queued row', () => queuedShown)
    queueObserver.disconnect()
    await until('queue delivered to fake agent', async () => {
      const snapshot = await smoke.terminalSnapshot(firstPrompt.sessionId)
      return (
        snapshot &&
        atob(snapshot.data)
          .replace(/\x1b\[(?:200|201)~/g, '')
          .includes('simple-received:Queued fixture follow-up @a')
      )
    })
    await until('queue cleared', () => !document.querySelector('.simple-queued'))
    assert(
      state().simple.log.some(
        (e) => e.kind === 'prompt' && e.text === 'Queued fixture follow-up @a',
      ),
      'queued prompt not logged',
    )
    await until(
      'queued turn working',
      () => state().sessions[firstPrompt.sessionId]?.status?.agent?.state === 'working',
    )
    input(document.querySelector('[aria-label="Message agent"]'), 'Immediate fixture follow-up')
    click(
      await until('Send anyway enabled mid-turn', () => {
        const b = button('Send anyway')
        return b && !b.disabled && b
      }),
    )
    await until('forced prompt delivered', () =>
      state().simple.log.some(
        (e) => e.kind === 'prompt' && e.text === 'Immediate fixture follow-up',
      ),
    )
    assert(!document.querySelector('.simple-queued'), 'Send anyway queued instead of sending')
    input(document.querySelector('[aria-label="Message agent"]'), 'Command shortcut follow-up @')
    await until('command mention options', () =>
      document.querySelector('.simple-composer [role="option"]'),
    )
    document
      .querySelector('[aria-label="Message agent"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    await until('Command+Enter sends through autocomplete', () =>
      state().simple.log.some(
        (e) => e.kind === 'prompt' && e.text === 'Command shortcut follow-up @',
      ),
    )
    await until('planner reply', () => chatText().includes('I planned the fixture feature'))
    await until('saved plan', () => chatText().includes('Simple fixture plan') && button('Build'))
    inChat()
    const planner = state().simple.log.find((e) => e.kind === 'prompt').sessionId
    assert(
      state().simple.log.some((e) => e.kind === 'reply' && e.sessionId === planner),
      'reply not persisted',
    )
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until('chat hidden before planner reveal', () => !document.querySelector('.simple-chat'))
    for (let request = 0; request < 2; request++) {
      smoke.revealTerminal({ sid: planner, componentId: '@plan' })
      await until('planner reveal restores chat', () => document.querySelector('.simple-chat'))
      if (request === 0) {
        click(document.querySelector('[aria-label="Hide chat"]'))
        await until(
          'chat hidden before repeated reveal',
          () => !document.querySelector('.simple-chat'),
        )
      }
    }
    click(button('View Planner terminal'))
    await until('planner drawer', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"] .xterm'),
    )
    await smoke.report('INFO simple: planner input and repeated reveals passed')
    click(button('Build'))
    await until('worktree build done', () => chatText().includes('Building done.'))
    inChat()
    const task = state().activeTask
    assert(task, 'Build did not create a worktree')
    await dragChat(-70)
    const taskChatWidth = chatWidth()
    state().setActiveTask(null, true)
    await until('root chat visible', () => chatWidth() > 0)
    if (initialRootChatWidth)
      assert(Math.abs(chatWidth() - initialRootChatWidth) < 0.1, 'root layout changed')
    state().setActiveTask(task)
    await until('worktree chat width restored', () => Math.abs(chatWidth() - taskChatWidth) < 0.1)
    assert(
      state().simple.log.some((e) => e.kind === 'prompt' && e.sessionId === planner),
      'conversation not carried into worktree',
    )
    await until(
      'open drawer keeps the selected Planner',
      () =>
        document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"] .xterm') &&
        button('Hide Planner terminal'),
    )
    assert(state().simple.selectedAgent === planner, 'workflow changed selected agent')
    click(button('Hide Planner terminal'))
    await until('drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    assert(document.querySelector('details.simple-section:not([open])'), 'earlier plan is expanded')
    const builder = state().simple.log.findLast((e) => e.action === 'implement').sessionId
    // A worktree with no stored layout must still reveal into the panel currently on screen.
    state().setActiveTask(null, true)
    await until('root chat before cross-worktree reveal', () =>
      document.querySelector('.simple-chat'),
    )
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until(
      'root Chat hidden before cross-worktree reveal',
      () => !document.querySelector('.simple-chat'),
    )
    const workspace = state().taskWorkspaces[task]
    smoke.store.setState({
      taskWorkspaces: {
        ...state().taskWorkspaces,
        [task]: { ...workspace, panels: {} },
      },
    })
    smoke.revealTerminal({ sid: builder, componentId: '@task' })
    await until(
      'unsaved worktree Chat revealed',
      () => state().activeTask === task && document.querySelector('.simple-chat'),
    )
    assert(chatWidth() >= 20, 'revealed Chat is below its minimum')
    await smoke.report('INFO simple: worktree widths and unsaved-layout reveal passed')
    await smoke.terminalWrite(builder, 'smoke-changes\n')
    await until('three changed files', () => button('Changes 3'))
    click(
      await until('Changes tab', () =>
        [...document.querySelectorAll('.view-tabs button')].find((b) =>
          b.textContent.trim().startsWith('Changes '),
        ),
      ),
    )
    await until('Changes pane', () => document.querySelector('.simple-diff'))
    const pane = document.querySelector('.simple-diff')
    await until('listed changes', () => pane.querySelectorAll('.change-row').length === 3)
    assert(button('Changes 3', pane), 'tab count differs from its file list')
    const selectedPath = () => pane.querySelector('.change-row[aria-selected="true"]')?.dataset.path
    const key = (key, target = document.activeElement ?? document.body) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    document.activeElement?.blur()
    const beforeClick = selectedPath()
    const untouched = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      bubbles: true,
      cancelable: true,
    })
    document.body.dispatchEvent(untouched)
    await sleep(100)
    assert(
      !untouched.defaultPrevented && selectedPath() === beforeClick,
      'body arrow stepped a file before any click',
    )
    pane.querySelector('aside h3').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    key('ArrowLeft')
    await until('body arrow moves selection', () => selectedPath() === 'src/app.txt')
    click(pane.querySelector('.change-row[data-path="src/another.txt"]'))
    assert(document.activeElement?.matches('.change-row'), 'clicked file row did not take focus')
    await until('clicked row selected', () => selectedPath() === 'src/another.txt')
    key('ArrowRight')
    await until('row arrow moves selection', () => selectedPath() === 'src/app.txt')
    click(
      await until('diff navigation ready', () =>
        pane.querySelector('[aria-label="Next changed file"]'),
      ),
    )
    await until('navigation icon moves selection', () => selectedPath() === 'src/third.txt')
    assert(document.activeElement?.matches('.diff-view'), 'navigation icon did not focus diff')
    key('ArrowLeft')
    await until('diff arrow moves selection', () => selectedPath() === 'src/app.txt')
    const paneBounds = pane.getBoundingClientRect()
    const asideBounds = pane.querySelector('aside').getBoundingClientRect()
    assert(
      asideBounds.left >= paneBounds.left && asideBounds.right <= paneBounds.right,
      'Changes list is clipped',
    )
    click(button('Map', pane))
    await until('Map returns', () => !document.querySelector('.simple-diff'))
    assert(!document.querySelector('.simple-file'), 'Changes card remains in the thread')
    click(await until('latest edited file link', () => button('Edited src/third.txt')))
    await until('Edited opens Changes', () =>
      document.querySelector(
        '.simple-diff .change-row[data-path="src/third.txt"][aria-selected="true"]',
      ),
    )
    click(button('Stories', document.querySelector('.simple-diff')))
    await until('Stories leaves Changes', () => !document.querySelector('.simple-diff'))
    click(button('Map'))
    await smoke.terminalWrite(builder, 'smoke-clean\n')
    await until('only committed change remains', () => button('Changes 1'))
    click(button('Review'))
    await until('review findings', () => chatText().includes('1 issues found.') && button('Fix'))
    inChat()
    click(
      await until('finding file reference', () =>
        document.querySelector('.simple-result .finding-ref'),
      ),
    )
    await until('finding opens Changes', () => document.querySelector('.simple-diff'))
    await until(
      'committed finding diff and line focus',
      () =>
        document.querySelector('.simple-diff .diff-view')?.textContent.includes('simple changed') &&
        document.querySelector('.simple-diff [data-new-line="1"]'),
    )
    click(button('Map', document.querySelector('.simple-diff')))
    state().setView('review')
    await until(
      'Full review includes committed branch changes',
      () =>
        document.querySelector('.review-view .change-row[data-path="src/app.txt"]') &&
        document.querySelector('.review-view .diff-view')?.textContent.includes('simple changed'),
    )
    assert(
      document
        .querySelector('.review-list')
        .textContent.includes('Changes since merge base with main'),
      'Full review did not show its comparison base',
    )
    click(document.querySelector('.review-findings-button'))
    click(
      await until('Full review finding reference', () =>
        document.querySelector('.review-pane .finding-ref'),
      ),
    )
    await until(
      'Full review finding opens its committed diff',
      () =>
        document.querySelector('.review-diff-back') &&
        document.querySelector('.review-view .diff-view')?.textContent.includes('simple changed') &&
        document.querySelector('.review-view [data-new-line="1"]'),
    )
    state().setView('navigation')
    state().setSimpleMode(true)
    const reviewer = state().simple.log.findLast((e) => e.action === 'review').sessionId
    click(
      await until('reviewer terminal button', () => {
        const article = document.querySelector(`[data-session="${reviewer}"]`)
        return article && button('View terminal', article)
      }),
    )
    await until('reviewer drawer shows its terminal', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="review terminal"] .xterm'),
    )
    assert(state().simple.selectedAgent === planner, 'reviewer View changed selected agent')
    click(button('Hide Reviewer terminal'))
    await until('reviewer drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    let flashed = false
    const monitor = new MutationObserver(() => {
      if (!chatText().includes('Fixes done.')) return
      const action = state().simple?.log.findLast((e) => e.action === 'fix')
      if (!action || !state().sessionRecords.some((r) => r.id === action.sessionId)) flashed = true
    })
    monitor.observe(document.querySelector('.simple-thread'), {
      childList: true,
      subtree: true,
      characterData: true,
    })
    await smoke.report('INFO simple: changes and review passed')
    click(button('Fix'))
    await until('fix done', () => chatText().includes('Fixes done.'))
    monitor.disconnect()
    assert(!flashed, 'Fixes done flashed before the fix session existed')
    click(button('Review again'))
    await until('clean follow-up review', () => chatText().includes('No issues. Merge into main?'))
    click(button('Merge'))
    await until('no conflict prompt', () => chatText().includes('No conflicts with main. Merge?'))
    click(button('Merge'))
    await until('merged', () => chatText().includes('Merged into main.'))
    inChat()
    // Release the merge agent's exclusive destination before starting another planner there.
    const merger = state().simple.log.findLast((e) => e.action === 'merge').sessionId
    await smoke.terminalStop(merger)
    await until('merge agent stopped', () => !state().sessions[merger]?.running)
    // Runs launched outside Chat have no block to scroll to. View must keep their output open
    // even after a successful or failed exit, and consume the reveal without claiming the run.
    for (const exitCode of [0, 1]) {
      await smoke.startTerminal('@plan', fake.id, task, projectId)
      await until(
        'external planner ready',
        () =>
          state().sessions[planner]?.running &&
          state().sessions[planner]?.status?.agent?.state === 'idle',
      )
      await smoke.terminalWrite(planner, `smoke-exit-${exitCode}\n`)
      await until('external planner exited', () => !state().sessions[planner]?.running)
      click(document.querySelector('[aria-label="Hide chat"]'))
      await until(
        'chat hidden before external reveal',
        () => !document.querySelector('.simple-chat'),
      )
      smoke.revealTerminal({ sid: planner, componentId: '@plan' })
      await until('external planner drawer', () =>
        document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"] .xterm'),
      )
      // Reconciliation reruns inputDrawer after View and used to clear the drawer's target.
      await smoke.reconcileSessions(false)
      await sleep(300)
      assert(
        document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"] .xterm'),
        `View lost external planner after exit ${exitCode}`,
      )
      assert(!state().revealed, 'external planner reveal was not consumed')
      assert(state().activeTask === task, 'external planner View changed chats')
      inChat()
      click(button('Hide Planner terminal'))
      await until(
        'external planner hidden',
        () => !document.querySelector('.simple-terminal-drawer'),
      )
    }
    // A permission wait belongs to its originating agent and opens only when requested.
    await smoke.startTerminal('@plan', fake.id, task, projectId)
    await until('planner restarted', () => state().sessions[planner]?.running)
    state().patchTask(projectId, task, {
      simple: {
        ...state().simple,
        log: [
          ...state().simple.log,
          {
            id: 'smoke-plan',
            kind: 'action',
            action: 'plan',
            stage: 'plan',
            sessionId: planner,
            generation: state().sessions[planner].generation,
            atMs: Date.now(),
          },
        ],
      },
    })
    await smoke.terminalWrite(planner, 'smoke-input\n')
    const question = await until('planner input question', () =>
      [...document.querySelectorAll('.chat-question')].find((el) =>
        el.textContent.includes('Allow fixture tool?'),
      ),
    )
    assert(state().simple.selectedAgent === planner, 'input wait changed selected agent')
    click(question.querySelector('summary'))
    await until('question terminal opened', () => question.querySelector('.xterm'))
    input(
      document.querySelector('[aria-label="Message agent"]'),
      'Do not answer the permission dialog',
    )
    // Nothing may send a chat prompt into the permission dialog.
    await until('force unavailable during input wait', () => !button('Send anyway'))
    assert(button('Queue') && !button('Queue').disabled, 'input wait cannot queue a follow-up')
    input(document.querySelector('[aria-label="Message agent"]'), '')
    const drawer = question.querySelector('.xterm')
    await smoke.terminalWrite(planner, 'a')
    await until(
      'first answer character changes status',
      () => state().sessions[planner]?.status?.agent?.state === 'working',
    )
    await sleep(300)
    assert(question.querySelector('.xterm') === drawer, 'input terminal unmounted while answering')
    assert(
      document.querySelector('.chat-question') === question,
      'input question changed while answering',
    )
    await smoke.terminalStop(planner)
    await until('stopped agent question closes', () => !document.querySelector('.chat-question'))
    const saved = smoke.workspaceDocument().projects.find((p) => p.id === projectId).layout
    assert(
      saved.taskWorkspaces[task].simple.log.some((e) => e.kind === 'reply'),
      'reply missing from saved workspace',
    )
    state().setSimpleMode(false)
    state().setSimpleMode(true)
    await until('replies survive remount', () =>
      chatText().includes('I planned the fixture feature'),
    )
    await smoke.report(
      'PASS simple: chat resize/hide/show and worktree widths, Enter queues and delivers, Changes tab/Map, collapsed history, no Fix flash, one conversation, plan/build/review/fix/merge, drawer input waits and persisted log',
    )
  } catch (e) {
    await smoke.report(
      `FAIL simple: ${e.message} ${e.stack ?? ''} chat=${chatText().slice(-1800)} message=${state().message}`,
    )
  }
})()
