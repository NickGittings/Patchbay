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
    [...root.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === text || b.getAttribute('aria-label') === text,
    )
  // React commits a click's update in a microtask; checking right after it skips a polling round.
  const soon = async (label, check) => {
    await Promise.resolve()
    return check() || until(label, check)
  }
  // Chat's ••• menu renders its items only while open.
  const chatMenu = async (text) => {
    const trigger = document.querySelector('[aria-label="Chat menu"]')
    if (trigger?.getAttribute('aria-expanded') !== 'true') trigger?.click()
    return soon(`chat menu: ${text}`, () =>
      button(text, document.querySelector('[role="menu"]') ?? document),
    )
  }
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
  // Only the lead talks in Chat; the agents its stages start keep their replies in their terminals.
  const agentSaid = (text) =>
    Object.values(state().sessions).some((s) => s.replies?.some((r) => r.text.includes(text)))
  const workflowText = () => document.querySelector('.chat-stepper')?.textContent ?? ''
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
    assert(
      !document.querySelector('.simple-chat > header [aria-label="Review options"]'),
      'redundant Review button remains in the header',
    )
    await until('root chat layout saved', () => smoke.chatPanel.width() > 0)
    const initialRootChatWidth = smoke.chatPanel.width()
    const initialRootLayout = { ...state().panels['App-simple'] }
    // Chat's one conversation lives in the project folder; the lead plans there and runs the
    // worktree's stages once it exists.
    const home = () =>
      state().activeTask === null ? state().simple : state().taskWorkspaces['']?.simple
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
    // Chat starts the project's lead in the project folder on the first message.
    smoke.store.setState({
      workspaceSettings: { ...state().workspaceSettings, chatAgent: fake.id },
    })
    const team = () => smoke.chatTeams.getState().teams[projectId]?.find((t) => t.task === null)
    const composer = document.querySelector('[aria-label="Message agent"]')
    const requestStage = async (id, { waitForResult = true } = {}) => {
      const textarea = document.querySelector('.simple-composer:not([hidden]) textarea')
      input(textarea, `smoke-stage ${id} ${state().activeTask}`)
      click(
        await until(`send ${id}`, () => {
          const send = button('Send', textarea.closest('.simple-composer'))
          return send && !send.disabled && send
        }),
      )
      await until(`lead workflow ${id}`, () => {
        const request = team()?.requests.find((request) => request.id === id)
        if (request?.state === 'failed') throw new Error(`${id}: ${request.result}`)
        return waitForResult ? request?.state === 'completed' : request
      })
    }
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
    assert(!home()?.log.some((e) => e.kind === 'prompt'), 'mention Enter sent a prompt')
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
      const entry = home()?.log.find((e) => e.kind === 'prompt')
      return entry && state().sessions[entry.sessionId]?.status?.agent?.state === 'working' && entry
    })
    assert(firstPrompt.mentions.includes('app'), 'consecutive Enter lost mention scope')
    await until('Chat lead started', () => team()?.lead.sessionId === firstPrompt.sessionId)
    if (team().state === 'paused') click(await chatMenu('Continue work'))
    await until('coordination running', () => team()?.state === 'running')
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
      home().log.some((e) => e.kind === 'prompt' && e.text === 'Queued fixture follow-up @a'),
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
      home().log.some((e) => e.kind === 'prompt' && e.text === 'Immediate fixture follow-up'),
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
      home().log.some((e) => e.kind === 'prompt' && e.text === 'Command shortcut follow-up @'),
    )
    await until('planner reply', () => chatText().includes('I planned the fixture feature'))
    await until(
      'saved plan and stage strip',
      () => chatText().includes('Simple fixture plan') && workflowText().includes('Build'),
    )
    assert(!document.querySelector('.simple-step'), 'workflow card remains in Chat')
    assert(!button('Review options'), 'Review options remain in Chat')
    assert(!document.querySelector('.chat-stepper button'), 'stage strip still shows actions')
    inChat()
    const planner = home().log.find((e) => e.kind === 'prompt').sessionId
    assert(
      home().log.some((e) => e.kind === 'reply' && e.sessionId === planner),
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
    // Scoped to the composer: message headers' pinning View buttons share this accessible name.
    click(button('View Lead terminal', document.querySelector('.simple-composer')))
    await until('planner drawer', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="Lead terminal"] .xterm'),
    )
    await smoke.report('INFO simple: planner input and repeated reveals passed')
    click(button('Close terminal', document.querySelector('.chat-terminal-panel')))
    await until('composer visible after closing the drawer', () =>
      document.querySelector('.simple-composer:not([hidden])'),
    )
    // The worktree starts from the plan's goal, saved as its plan.
    await smoke.createTask(
      { title: 'Simple chat build', branch: 'simple-chat-build', components: ['app'] },
      'Simple fixture plan',
    )
    await requestStage('build')
    await until('build reply', () => agentSaid('Built the fixture feature.'))
    inChat()
    click(button('View Lead terminal', document.querySelector('.simple-composer')))
    await until('planner drawer reopened', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="Lead terminal"] .xterm'),
    )
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
      home().log.some((e) => e.kind === 'prompt' && e.sessionId === planner),
      'conversation not carried into worktree',
    )
    await until(
      'open drawer keeps the selected Planner',
      () =>
        document.querySelector('.simple-terminal-drawer[aria-label="Lead terminal"] .xterm') &&
        document.querySelector('.simple-composer[hidden]'),
    )
    assert(home().selectedAgent === planner, 'workflow changed selected agent')
    const draft = document.querySelector('.simple-composer textarea').value
    click(button('Close terminal', document.querySelector('.chat-terminal-panel')))
    await until('drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    assert(
      !document.querySelector('.simple-composer[hidden]') &&
        document.querySelector('.simple-composer textarea').value === draft,
      'closing the terminal did not restore the composer and its draft',
    )
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
    // The builder isn't in the conversation, so View opens its terminal in Chat's drawer.
    const builderDrawer = await until('builder terminal in the drawer', () =>
      document.querySelector('.chat-terminal-panel'),
    )
    click(button('Close terminal', builderDrawer))
    await until('composer after the builder drawer', () =>
      document.querySelector('.simple-composer:not([hidden]) textarea'),
    )
    await smoke.report('INFO simple: worktree widths and unsaved-layout reveal passed')
    await smoke.terminalWrite(builder, 'smoke-changes\n')
    await until('three changed files', () => button('Changes 3'))
    const agentsTab = () =>
      [...document.querySelectorAll('.view-tabs button')].find((b) =>
        b.textContent.trim().startsWith('Agents '),
      )
    click(await until('Agents tab', agentsTab))
    await until('builder card', () =>
      document.querySelector(`.agent-card[data-session="${CSS.escape(builder)}"]`),
    )
    // Changes opens on the newest edit, once the agent's activity has reported it.
    await until('builder edit reported', () =>
      state().sessions[builder]?.activity?.some((a) => a.target?.endsWith('src/third.txt')),
    )
    click(
      await until('Changes tab', () =>
        [...document.querySelectorAll('.view-tabs button')].find((b) =>
          b.textContent.trim().startsWith('Changes '),
        ),
      ),
    )
    await until('Changes pane', () => document.querySelector('.simple-diff'))
    let pane = document.querySelector('.simple-diff')
    await until('listed changes', () => pane.querySelectorAll('.change-row').length === 3)
    assert(button('Changes 3', pane), 'tab count differs from its file list')
    assert(pane.querySelector('.review-context strong'), 'missing worktree context')
    assert(
      pane.querySelector('.review-context code')?.textContent ===
        state().tasks.find((t) => t.id === task)?.branch,
      'wrong Changes branch',
    )
    assert(
      pane.querySelector('.review-totals')?.textContent.includes('3 files'),
      'missing total file count',
    )
    assert(pane.querySelector('.review-totals .diff-stat'), 'missing total line counts')
    const group = pane.querySelector('.review-group')
    const toggle = group.querySelector('.review-toggle')
    assert(toggle.getAttribute('aria-expanded') === 'true', 'group did not start expanded')
    await until('selected diff loaded', () => pane.querySelector('.diff-view [data-new-line]'))
    // The file stepper only counts expanded groups, so compare the diff without it.
    const diffText = () => {
      const view = pane.querySelector('.diff-view')?.cloneNode(true)
      view?.querySelector('.diff-nav')?.remove()
      return view?.textContent
    }
    const openDiff = diffText()
    click(toggle)
    await until('collapsed change group', () => !group.querySelector('.change-list'))
    assert(toggle.getAttribute('aria-expanded') === 'false', 'collapse state not exposed')
    assert(diffText() === openDiff, 'collapse changed the diff')
    click(toggle)
    await until('expanded change group', () => group.querySelector('.change-list'))
    click(pane.querySelector('[aria-label="Refresh changes"]'))
    await until('refreshed changes', () => pane.querySelectorAll('.change-row').length === 3)

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
    pane
      .querySelector('.review-group-header')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
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
    // Recent commits live in the rail's Git panel; a chosen commit opens in Chat's Changes.
    if (!document.querySelector('.utility-panel[data-panel="git"]'))
      click(
        await until('Git rail button', () =>
          document.querySelector('.workspace-rail [aria-label="Git"]'),
        ),
      )
    const gitPanel = await until('Git panel', () =>
      document.querySelector('.utility-panel[data-panel="git"]'),
    )
    // The history's open state persists across launches, so open it if a run left it collapsed.
    const historyToggle = await until('history header', () =>
      gitPanel.querySelector('.commit-history header button'),
    )
    if (historyToggle.getAttribute('aria-expanded') !== 'true') click(historyToggle)
    click(await until('recent commit', () => gitPanel.querySelector('.commit-row')))
    await until('commit details', () => pane.querySelector('.commit-details'))
    click(pane.querySelector('.change-row[data-path="src/app.txt"]'))
    await until('working diff after history', () => !pane.querySelector('.commit-details'))
    // Close the Git panel so later layout checks see Chat at its usual width.
    click(document.querySelector('.workspace-rail [aria-label="Git"]'))
    await until(
      'Git panel closed',
      () => !document.querySelector('.utility-panel[data-panel="git"]'),
    )
    click(pane.querySelector('.review-toggle'))
    await until('group collapsed before switching', () =>
      pane.querySelector('.review-toggle[aria-expanded="false"]'),
    )
    const selection = () => smoke.simpleUi.getState().worktrees[smoke.simpleKey(projectId, task)]
    assert(selection().changes && selection().diff, 'missing selection before worktree switch')
    state().setActiveTask(null, true)
    state().setActiveTask(task, true)
    assert(
      state().activeTask === task && !selection().changes && !selection().diff,
      'a quick worktree round trip kept Changes selected',
    )
    state().setActiveTask(null, true)
    // Root Chat stays hidden from the earlier cross-worktree reveal check; only the switch matters.
    await until(
      'root conversation',
      () =>
        state().activeTask === null &&
        document.querySelector('.simple-chat, .simple-show-chat') &&
        !document.querySelector('.simple-diff'),
    )
    state().setActiveTask(task)
    await until('worktree conversation', () => document.querySelector('.simple-chat'))
    click(await until('worktree Changes tab', () => button('Changes 3')))
    pane = await until('worktree Changes restored', () => document.querySelector('.simple-diff'))
    await until('restored expanded groups', () => pane.querySelectorAll('.change-row').length === 3)
    assert(
      !pane.querySelector('.review-toggle[aria-expanded="false"]'),
      'collapsed groups leaked across worktree switch',
    )
    click(button('Map', pane))
    await until('Map returns', () => !document.querySelector('.simple-diff'))
    assert(!document.querySelector('.simple-file'), 'Changes card remains in the thread')
    // Only the lead's blocks show in Chat, so the builder's edit is picked from Changes.
    click(
      await until('Changes tab for the edited file', () =>
        [...document.querySelectorAll('.view-tabs button')].find((b) =>
          b.textContent.trim().startsWith('Changes '),
        ),
      ),
    )
    click(
      await until('edited file row', () =>
        document.querySelector('.simple-diff .change-row[data-path="src/third.txt"]'),
      ),
    )
    const editedDiff = () =>
      document.querySelector(
        '.simple-diff .change-row[data-path="src/third.txt"][aria-selected="true"]',
      )
    await until('edited file selected in Changes', editedDiff)
    smoke.selectRailView('plan')
    await until('Full Plan', () => !document.querySelector('.navigation-shell'))
    smoke.selectRailView('navigation')
    const fullMap = await until('Full Navigation map', () =>
      document.querySelector('.navigation-map'),
    )
    assert(
      !fullMap.inert && !document.querySelector('.agent-canvas'),
      'Agents covered the map after opening a file and switching to Full',
    )
    state().setSimpleMode(true)
    await until('Chat restores the selected file', editedDiff)
    click(button('Stories', document.querySelector('.simple-diff')))
    await until('Stories leaves Changes', () => !document.querySelector('.simple-diff'))
    click(button('Map'))
    await smoke.terminalWrite(builder, 'smoke-clean\n')
    await until('only committed change remains', () => button('Changes 1'))
    await requestStage('review')
    await until('review findings', () => document.querySelector('.simple-result .finding-ref'))
    inChat()
    click(await until('Agents before finding', agentsTab))
    click(
      await until('finding file reference', () =>
        document.querySelector('.simple-result .finding-ref'),
      ),
    )
    await until('finding opens Changes', () => document.querySelector('.simple-diff'))
    assert(!selection().agents, 'opening a finding kept Agents selected')
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
    // Only the lead's blocks show in Chat; the reviewer's terminal opens from its Agents card.
    click(await until('Agents before the reviewer terminal', agentsTab))
    click(
      await until('reviewer terminal button', () =>
        document.querySelector(
          `.agent-card[data-session="${CSS.escape(reviewer)}"] button[aria-label^="View "]`,
        ),
      ),
    )
    await until('reviewer drawer shows its terminal', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="Reviewer terminal"] .xterm'),
    )
    assert(home().selectedAgent === planner, 'reviewer View changed selected agent')
    click(button('Close terminal', document.querySelector('.chat-terminal-panel')))
    await until('reviewer drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    await smoke.report('INFO simple: changes and review passed')
    await requestStage('fix')
    await until('fix reply', () => agentSaid('Fixed the review finding.'))
    await requestStage('review-again')
    await until('clean follow-up review', () => agentSaid('The review is clean.'))
    await requestStage('merge', { waitForResult: false })
    await until('lead merge recorded', () =>
      [...(state().simple.retainedWorkflow ?? []), ...state().simple.log].some(
        (e) => e.action === 'merge' && e.origin === 'lead',
      ),
    )
    // The timeline narrates the merge until the confirmed merge into main clears Chat.
    await until(
      'merged',
      () =>
        chatText().includes('Merged into main.') ||
        (state().simple.clearBoundary && !state().simple.log.length),
    )
    inChat()
    // Release the merge agent's exclusive destination before starting another planner there.
    const merger = [...(state().simple.retainedWorkflow ?? []), ...state().simple.log].findLast(
      (e) => e.action === 'merge',
    ).sessionId
    const leadBeforeClear = state().sessions[planner]
    await until(
      'Chat cleared after merging into main',
      () => state().simple.clearBoundary && !state().simple.log.length,
    )
    // One worktree's merge clears its own results; the project's conversation keeps the lead's.
    assert(
      chatText().includes('I planned the fixture feature'),
      "merging a worktree cleared the project's conversation",
    )
    assert(
      state().sessions[planner]?.generation === leadBeforeClear.generation &&
        state().sessions[planner]?.running === leadBeforeClear.running,
      'clearing merged Chat changed the lead terminal',
    )
    await smoke.terminalStop(merger)
    await until('merge agent stopped', () => !state().sessions[merger]?.running)
    // A permission wait belongs to the lead that asks and opens only when requested.
    await until('lead ready for input', () => {
      const session = state().sessions[planner]
      return (
        session?.running &&
        ['idle', 'review'].includes(session.status?.agent?.state) &&
        !smoke.leadDeliveryPending(projectId, null, planner, session.generation)
      )
    })
    await smoke.terminalWrite(planner, 'smoke-input\n')
    const question = await until('lead input question', () =>
      [...document.querySelectorAll('.chat-question')].find((el) =>
        el.textContent.includes('Allow fixture tool?'),
      ),
    )
    assert(home().selectedAgent === planner, 'input wait changed selected agent')
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
    // View must keep an external run's output open after exit without claiming the run.
    const external = smoke.sessionId('@plan', fake.id, task)
    for (const exitCode of [0, 1]) {
      const previousGeneration = state().sessions[external]?.generation
      await smoke.startTerminal('@plan', fake.id, task, projectId)
      await until('external planner ready', () => {
        const session = state().sessions[external]
        const agent = session?.status?.agent
        return (
          session?.running &&
          session.generation !== previousGeneration &&
          agent?.authoritative &&
          ['idle', 'review'].includes(agent.state)
        )
      })
      await smoke.terminalWrite(external, `smoke-exit-${exitCode}\n`)
      await until('external planner exited', () => !state().sessions[external]?.running)
      click(document.querySelector('[aria-label="Hide chat"]'))
      await until(
        'chat hidden before external reveal',
        () => !document.querySelector('.simple-chat'),
      )
      smoke.revealTerminal({ sid: external, componentId: '@plan' })
      const externalDrawer = () =>
        document.querySelector('.simple-terminal-drawer[aria-label$=" terminal"] .xterm')
      await until('external planner drawer', externalDrawer)
      // Reconciliation reruns inputDrawer after View and used to clear the drawer's target.
      await smoke.reconcileSessions(false)
      await sleep(300)
      assert(externalDrawer(), `View lost external planner after exit ${exitCode}`)
      assert(!state().revealed, 'external planner reveal was not consumed')
      assert(state().activeTask === task, 'external planner View changed the focus')
      inChat()
      click(button('Close terminal', document.querySelector('.chat-terminal-panel')))
      await until(
        'external planner hidden',
        () => !document.querySelector('.simple-terminal-drawer'),
      )
    }
    const saved = smoke.workspaceDocument().projects.find((p) => p.id === projectId).layout
    assert(
      saved.taskWorkspaces[task].simple.clearBoundary &&
        !saved.taskWorkspaces[task].simple.log.length,
      'merged worktree clear missing from saved workspace',
    )
    state().setSimpleMode(false)
    state().setSimpleMode(true)
    await sleep(300)
    assert(
      chatText().includes('I planned the fixture feature') && !state().simple.log.length,
      "remount lost the conversation or restored the merged worktree's results",
    )
    await smoke.report(
      'PASS simple: chat resize/hide/show and worktree widths, Enter queues and delivers, Changes tab/Map, collapsed history, lead launches Build/Review/Fix/Merge in one conversation, merged worktree cleanup that keeps the project conversation and the lead terminal, drawer input waits and persisted clear',
    )
  } catch (e) {
    await smoke.report(
      `FAIL simple: ${String(e)} ${e.stack ?? ''} view=${state().view} simple=${state().simpleMode} board=${state().storyBoard} workflow=${workflowText()} chat=${chatText().slice(-1800)} message=${state().message} drawer=${document.querySelector('.simple-terminal-drawer')?.getAttribute('aria-label')} xterm=${!!document.querySelector('.simple-terminal-drawer .xterm')} tabs=${[...document.querySelectorAll('.view-tabs button')].map((b) => b.textContent.trim()).join('|')} active=${state().activeTask} wlog=${JSON.stringify([...(state().simple?.retainedWorkflow ?? []), ...(state().simple?.log ?? [])].map((e) => [e.kind, e.action, e.origin]))} req=${JSON.stringify(
        Object.values(smoke.chatTeams.getState().teams)
          .flat()
          .flatMap((t) => (t.requests ?? []).map((r) => [r.id, r.state, r.result?.slice(0, 160)])),
      )}`,
    )
  }
})()
