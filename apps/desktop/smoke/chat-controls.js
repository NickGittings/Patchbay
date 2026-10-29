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
    await until('Inspector beside chat', () => state().panels['App-simple']['App-pane-5'] > 0)
    assert(Math.abs(chatWidth() - rootChatWidth) < 0.1, 'Inspector changed chat width')
    click(document.querySelector('[aria-label="Hide chat"]'))
    await until(
      'chat hidden beside Inspector',
      () => !document.querySelector('.simple-chat') && chatWidth() === 0,
    )
    assert(state().panels['App-simple']['App-pane-5'] > 0, 'Hide chat closed Inspector')
    click(button('Show chat'))
    await until(
      'chat restored beside Inspector',
      () => document.querySelector('.simple-chat') && Math.abs(chatWidth() - rootChatWidth) < 0.1,
    )
    const besideInspector = { ...state().panels['App-simple'] }
    state().setPanelLayout('App-simple', {
      'App-pane-2': 12,
      'App-simple-chat': 0,
      'App-pane-5': 88,
    })
    await until('narrow canvas beside Inspector', () => button('Show chat') && chatWidth() === 0)
    click(button('Show chat'))
    await until(
      'chat opens above its minimum',
      () => document.querySelector('.simple-chat') && chatWidth() >= 20,
    )
    state().setPanelLayout('App-simple', besideInspector)
    await until(
      'chat width restored after minimum check',
      () => Math.abs(chatWidth() - rootChatWidth) < 0.1,
    )
    smoke.store.setState({ inspector: false })
    await until('Inspector hidden', () => state().panels['App-simple']['App-pane-5'] === 0)
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
    const second = await smoke.openSecondProject()
    smoke.acceptOpened(second)
    state().setSimpleMode(true)
    await sleep(100)
    await until('second project Chat', () => document.querySelector('.simple-chat'))
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
      'PASS chat controls: resize/hide/show, remembered widths, Inspector isolation, minimum width, Chat entry and project tabs from every Full view',
    )
  } catch (e) {
    await smoke.report(
      `FAIL chat controls: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
