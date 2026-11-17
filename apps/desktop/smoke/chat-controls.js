// Chat panel controls and layout persistence, without starting agent sessions.
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
  // React commits a click's update in a microtask; checking right after it avoids a polling round,
  // which background smoke windows throttle to about a second.
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
  const confirmDialog = (title) => document.querySelector(`[role="dialog"][aria-label="${title}"]`)
  const click = (el) => {
    assert(el, 'missing click target')
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
    await smoke.syncCurrentRoots()
    state().setSimpleMode(true)
    await until('chat', () => document.querySelector('.simple-chat'))
    // Explicit identity stays stable when another agent asks a question.
    await until('chat agent indicator', () => document.querySelector('.chat-agent-picker'))
    assert(!state().simple?.selectedAgent, 'opening chat started an agent')
    assert(!document.querySelector('[aria-label="Chat lead"]'), 'legacy lead picker remains')
    const originalRecords = state().sessionRecords
    const originalSessions = state().sessions
    const originalSimple = state().simple
    const agent = (id, name) => ({
      id,
      metadata: {
        projectId,
        kind: 'agent',
        componentId: '@task',
        task: null,
        name,
        terminalId: id,
        adapter: 'codex',
      },
      spec: { cwd: state().project.root, command: 'codex' },
      snapshot: null,
      history: [],
    })
    const first = agent('chat-smoke-first', 'First agent')
    const asking = agent('chat-smoke-second', 'Second agent')
    smoke.store.setState({
      sessionRecords: [...originalRecords, first, asking],
      sessions: {
        ...originalSessions,
        [first.id]: {
          running: true,
          generation: 1,
          status: { agent: { state: 'idle', authoritative: true, provider: 'codex', sinceMs: 1 } },
        },
        [asking.id]: {
          running: true,
          generation: 1,
          status: {
            agent: {
              state: 'needsInput',
              authoritative: true,
              provider: 'codex',
              sinceMs: 2,
              message: 'Which behavior?',
            },
          },
        },
      },
    })
    state().patchTask(projectId, null, { simple: { ...state().simple, selectedAgent: first.id } })
    await until('selected identity', () =>
      document.querySelector('.chat-recipient')?.textContent.includes('First agent'),
    )
    assert(
      document.querySelector('.chat-agent-picker').textContent.includes('First agent'),
      'question changed selected agent',
    )
    assert(
      document.querySelector('.chat-question summary')?.textContent.includes('Second agent'),
      'question lost originating agent',
    )
    click(await chatMenu('Clear visible history…'))
    const clear = await until('visible history confirmation', () =>
      confirmDialog('Clear visible history'),
    )
    click(button('Cancel', clear))
    await until('clear cancelled', () => !confirmDialog('Clear visible history'))
    assert(state().simple.selectedAgent === first.id, 'visible clear changed lead')
    // Follow the latest on mount, but preserve a reader's position when replies arrive.
    const now = Date.now()
    const source =
      '# Saved Markdown\n\n[Docs](https://example.com) and [local](/tmp/a)\n\n| One | Two |\n| --- | --- |\n| a | b |\n\n```ts\n  exact\tcode \n```\n\n' +
      Array.from({ length: 80 }, (_, i) => `Paragraph ${i}\n\n`).join('')
    const prompt = {
      id: 'scroll-prompt',
      kind: 'prompt',
      stage: 'build',
      sessionId: first.id,
      generation: 1,
      text: 'Inspect this',
      mentions: [],
      atMs: now,
    }
    const reply = {
      id: 'scroll-reply',
      kind: 'reply',
      stage: 'build',
      sessionId: first.id,
      generation: 1,
      sequence: 1,
      text: source,
      atMs: now + 1,
    }
    state().patchTask(projectId, null, {
      simple: { ...state().simple, startedMs: now, log: [prompt, reply] },
    })
    const thread = await until('rendered reply', () =>
      document.querySelector('.simple-thread:has(.simple-reply)'),
    )
    await until(
      'following latest',
      () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 5,
    )
    assert(
      document.querySelector('.simple-reply time')?.title,
      'message timestamp missing full date',
    )
    assert(document.querySelector('.markdown-table table th'), 'table not rendered semantically')
    assert(
      document.querySelector('.simple-reply a')?.getAttribute('href') === 'https://example.com',
      'web link missing',
    )
    assert(
      document.querySelectorAll('.simple-reply a').length === 1,
      'local path became interactive',
    )
    thread.scrollTop = 0
    thread.dispatchEvent(new Event('scroll'))
    await until('jump control', () => button('Jump to latest'))
    const before = thread.scrollTop
    const incoming = {
      ...reply,
      id: 'scroll-reply-2',
      sequence: 2,
      text: 'A newly received reply',
      atMs: Date.now() + 1,
    }
    state().patchTask(projectId, null, {
      simple: { ...state().simple, log: [prompt, reply, incoming] },
    })
    await until('unread reply', () => button('Jump to latest (1 new reply)'))
    assert(Math.abs(thread.scrollTop - before) < 2, 'new reply moved reader')
    state().patchTask(projectId, null, {
      simple: { ...state().simple, log: [prompt, reply, incoming] },
    })
    await sleep(100)
    assert(button('Jump to latest (1 new reply)'), 'reconciliation counted duplicate reply')
    thread.scrollTop = 220
    thread.dispatchEvent(new Event('scroll'))
    await sleep(50)
    const visibleReply = thread.querySelector('.simple-reply:has(.markdown-code)')
    const offset = visibleReply.getBoundingClientRect().top - thread.getBoundingClientRect().top
    const historical = {
      ...reply,
      id: 'reconciled-history',
      sequence: 3,
      atMs: now,
      text: 'Older reconciled reply\n\n'.repeat(15),
    }
    state().patchTask(projectId, null, {
      simple: { ...state().simple, log: [prompt, historical, reply, incoming] },
    })
    await until('historical reconciliation', () => chatText().includes('Older reconciled reply'))
    assert(
      Math.abs(
        visibleReply.getBoundingClientRect().top - thread.getBoundingClientRect().top - offset,
      ) < 2,
      'historical reconciliation moved the visible reply',
    )
    assert(
      button('Jump to latest (1 new reply)'),
      'historical reconciliation created unread replies',
    )
    click(button('Jump to latest (1 new reply)'))
    await until(
      'jump resumes following',
      () =>
        !document.querySelector('.simple-jump') &&
        thread.scrollHeight - thread.scrollTop - thread.clientHeight < 5,
    )
    thread.scrollTop = 0
    thread.dispatchEvent(new Event('scroll'))
    await until('away again', () => document.querySelector('.simple-jump'))
    thread.scrollTop = thread.scrollHeight
    thread.dispatchEvent(new Event('scroll'))
    await until('manual bottom clears jump', () => !document.querySelector('.simple-jump'))
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    let copied
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copied = text
        },
      },
    })
    try {
      click(button('Copy code', thread))
      await until('code copied', () => copied === '  exact\tcode \n')
      click(button('Copy message', thread.querySelector('.simple-reply:has(.markdown-code)')))
      await until('saved message copied', () => copied === source)
      navigator.clipboard.writeText = async () => {
        throw new Error('clipboard fixture')
      }
      click(thread.querySelector('.simple-reply:has(.markdown-code) .copy-control button'))
      await until(
        'actionable clipboard failure',
        () => button('Retry copy') && chatText().includes('select and copy'),
      )
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      else delete navigator.clipboard
    }
    const composer = document.querySelector('[aria-label="Message agent"]')
    composer.focus()
    input(composer, '@')
    composer.setSelectionRange(1, 1)
    composer.dispatchEvent(new Event('select', { bubbles: true }))
    const popup = await until('component mentions', () =>
      document.querySelector('[role="listbox"]'),
    )
    const press = (key, extra = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra })
      composer.dispatchEvent(event)
      return event
    }
    assert(
      composer.getAttribute('role') === 'combobox' &&
        composer.getAttribute('aria-controls') === popup.id,
      'mention semantics missing',
    )
    press('ArrowUp')
    await sleep(50)
    const options = popup.querySelectorAll('[role="option"]')
    assert(
      options[options.length - 1].getAttribute('aria-selected') === 'true',
      'Up did not wrap selection',
    )
    assert(
      composer.getAttribute('aria-activedescendant') === options[options.length - 1].id,
      'active descendant mismatch',
    )
    press('ArrowDown')
    await sleep(50)
    assert(options[0].getAttribute('aria-selected') === 'true', 'Down did not wrap selection')
    assert(!press('Enter', { shiftKey: true }).defaultPrevented, 'Shift+Enter lost newline')
    assert(!press('Enter', { isComposing: true }).defaultPrevented, 'IME Enter was intercepted')
    press('Escape')
    await until('mention dismissed', () => !document.querySelector('[role="listbox"]'))
    composer.dispatchEvent(new Event('select', { bubbles: true }))
    await sleep(50)
    assert(!document.querySelector('[role="listbox"]'), 'dismissal did not last for query')
    input(composer, '@a')
    composer.setSelectionRange(2, 2)
    composer.dispatchEvent(new Event('select', { bubbles: true }))
    await until('changed mention query', () => document.querySelector('[role="option"]'))
    press('Enter')
    await until(
      'mention inserted',
      () =>
        smoke.simpleUi.getState().worktrees[smoke.simpleKey(projectId, null)]?.mentions.length ===
        1,
    )
    assert(document.activeElement === composer, 'mention stole textarea focus')
    input(composer, '@')
    composer.setSelectionRange(1, 1)
    composer.dispatchEvent(new Event('select', { bubbles: true }))
    click(await until('mouse mention', () => document.querySelector('[role="option"]')))
    assert(document.activeElement === composer, 'mouse mention stole textarea focus')
    smoke.simpleUi.getState().patch(smoke.simpleKey(projectId, null), { draft: '', mentions: [] })
    await smoke.resizeWindow(900, 700)
    await sleep(100)
    assert(
      document.querySelector('.simple-chat').scrollWidth <=
        document.querySelector('.simple-chat').clientWidth + 1,
      'narrow chat overflows',
    )
    await smoke.resizeWindow(1440, 900)
    thread.scrollTop = 0
    thread.dispatchEvent(new Event('scroll'))
    await until('away before remount', () => document.querySelector('.simple-jump'))
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until('hidden before remount', () => !document.querySelector('.simple-chat'))
    click(button('Show chat'))
    await until('remount follows latest', () => {
      const el = document.querySelector('.simple-thread')
      return (
        el &&
        !document.querySelector('.simple-jump') &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 5
      )
    })
    const remountedThread = document.querySelector('.simple-thread')
    remountedThread.scrollTop = 0
    remountedThread.dispatchEvent(new Event('scroll'))
    await until('away before scope change', () => document.querySelector('.simple-jump'))
    await smoke.createTask({ title: 'Follow scope', branch: 'follow-scope', components: ['app'] })
    await until(
      'other follow scope',
      () => state().activeTask && document.querySelector('.simple-chat'),
    )
    assert(!document.querySelector('.simple-jump'), 'worktree inherited unread state')
    state().setActiveTask(null)
    await until('returning scope follows latest', () => {
      const el = document.querySelector('.simple-thread')
      return (
        !state().activeTask &&
        el &&
        !document.querySelector('.simple-jump') &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 5
      )
    })
    click(await chatMenu('Clear visible history…'))
    click(
      button(
        'Clear',
        await until('clear visible history', () => confirmDialog('Clear visible history')),
      ),
    )
    await until('visible history cleared', () => !chatText().includes('Saved Markdown'))
    assert(!document.querySelector('.simple-jump'), 'history clear created unread replies')
    smoke.store.setState({ sessionRecords: originalRecords, sessions: originalSessions })
    state().patchTask(projectId, null, { simple: originalSimple })
    // A confirmation belongs to one visit to a worktree, even after switching away and back.
    click(await chatMenu('Clear visible history…'))
    await until('confirmation before task switch', () => confirmDialog('Clear visible history'))
    await smoke.createTask({
      title: 'Clear confirmation',
      branch: 'clear-confirmation',
      components: ['app'],
    })
    await until(
      'other task chat',
      () => state().activeTask && document.querySelector('.simple-chat'),
    )
    assert(!confirmDialog('Clear visible history'), 'task inherited clear confirmation')
    state().setActiveTask(null)
    await until(
      'original task chat',
      () => !state().activeTask && document.querySelector('.simple-chat'),
    )
    assert(!confirmDialog('Clear visible history'), 'returning task reopened confirmation')
    // Chat's resize handle must receive pointer hits even while Inspector is hidden.
    const { width: chatWidth, drag: dragChat } = smoke.chatPanel
    await dragChat(-160)
    await dragChat(70)
    const rootChatWidth = chatWidth()
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until('chat hidden', () => !document.querySelector('.simple-chat') && chatWidth() === 0)
    assert(
      Math.abs(state().panels['App-simple']['App-pane-2'] - 100) < 0.1,
      'canvas did not take chat width',
    )
    await sleep(100)
    assert(!document.querySelector('.simple-chat'), 'hidden chat reopened')
    click(button('Show chat'))
    await until(
      'chat restored at dragged size',
      () => document.querySelector('.simple-chat') && Math.abs(chatWidth() - rootChatWidth) < 0.1,
    )
    smoke.store.setState({ inspector: true })
    await until('Inspector beside chat', () => state().panels['Workspace-panels']['App-pane-5'] > 0)
    assert(Math.abs(chatWidth() - rootChatWidth) < 0.1, 'Inspector changed chat width')
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until(
      'chat hidden beside Inspector',
      () => !document.querySelector('.simple-chat') && chatWidth() === 0,
    )
    assert(state().panels['Workspace-panels']['App-pane-5'] > 0, 'Hide chat closed Inspector')
    click(button('Show chat'))
    await until(
      'chat restored beside Inspector',
      () => document.querySelector('.simple-chat') && Math.abs(chatWidth() - rootChatWidth) < 0.1,
    )
    const besideInspector = { ...state().panels['App-simple'] }
    const workspaceBesideInspector = { ...state().panels['Workspace-panels'] }
    state().setPanelLayout('Workspace-panels', {
      'App-pane-5': 70,
      'file-editor-pane': 0,
      'file-editor-content': 30,
    })
    state().setPanelLayout('App-simple', {
      'App-pane-2': 100,
      'App-simple-chat': 0,
    })
    await until('narrow canvas beside Inspector', () => button('Show chat') && chatWidth() === 0)
    click(button('Show chat'))
    await until(
      'chat opens above its minimum',
      () => document.querySelector('.simple-chat') && chatWidth() >= 20,
    )
    state().setPanelLayout('App-simple', besideInspector)
    state().setPanelLayout('Workspace-panels', workspaceBesideInspector)
    await until(
      'chat width restored after minimum check',
      () => Math.abs(chatWidth() - rootChatWidth) < 0.1,
    )
    smoke.store.setState({ inspector: false })
    await until('Inspector hidden', () => state().panels['Workspace-panels']['App-pane-5'] === 0)
    for (const view of ['navigation', 'plan', 'implementation', 'review']) {
      click(document.querySelector('[aria-label="Hide chat"]'))
      await until(
        'chat hidden before switching views',
        () => !document.querySelector('.simple-chat'),
      )
      state().setSimpleMode(false)
      state().setView(view)
      await until(`Full ${view}`, () => !document.querySelector('.simple-chat'))
      await sleep(100)
      state().setSimpleMode(true)
      await until(`chat restored from ${view}`, () => document.querySelector('.simple-chat'))
      assert(Math.abs(chatWidth() - rootChatWidth) < 0.1, `${view} lost chat width`)
    }
    // Project tabs restore hidden Chat from every Full view without replaying entry requests.
    click(await chatMenu('Clear visible history…'))
    await until('confirmation before project switch', () => confirmDialog('Clear visible history'))
    const second = await smoke.openSecondProject()
    smoke.acceptOpened(second)
    state().setSimpleMode(true)
    await sleep(100)
    await until('second project Chat', () => document.querySelector('.simple-chat'))
    assert(!confirmDialog('Clear visible history'), 'project inherited clear confirmation')
    state().activateProject(projectId)
    await until('original project Chat', () => document.querySelector('.simple-chat'))
    assert(!confirmDialog('Clear visible history'), 'returning project reopened confirmation')
    state().activateProject(second.id)
    await until('second project Chat again', () => document.querySelector('.simple-chat'))
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until('second project Chat hidden', () => !document.querySelector('.simple-chat'))
    const hiddenLayout = { ...state().panels['App-simple'] }
    for (const view of ['navigation', 'plan', 'implementation', 'review']) {
      state().activateProject(projectId)
      state().setSimpleMode(false)
      state().setView(view)
      await sleep(100)
      state().activateProject(second.id)
      await until('second project Show chat', () => button('Show chat'))
      await sleep(150)
      assert(!document.querySelector('.simple-chat'), `${view} reopened another project's Chat`)
      for (const [id, size] of Object.entries(hiddenLayout))
        assert(Math.abs(state().panels['App-simple'][id] - size) < 0.1, `${view} overwrote ${id}`)
      state().setSimpleMode(true)
      await sleep(100)
      assert(!document.querySelector('.simple-chat'), 'idempotent Chat selection reopened Chat')
    }
    state().activateProject(projectId)
    state().setView('navigation')
    state().setSimpleMode(true)
    await until('chat restored to Navigation', () => document.querySelector('.simple-chat'))
    await smoke.report(
      'PASS chat controls: follow/unread and remount/worktree resets, exact message/code copying and clipboard errors, semantic Markdown, keyboard/IME/mouse mentions, visible clearing, narrow panels, resize/hide/show and project tabs',
    )
  } catch (e) {
    await smoke.report(
      `FAIL chat controls: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
