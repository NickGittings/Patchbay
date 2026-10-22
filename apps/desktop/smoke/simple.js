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
  // Chat mode is a checkable item in the toolbar's Settings menu.
  const toggleSimple = async () => {
    const settings = [...document.querySelectorAll('.toolbar .menu')].find(
      (m) => m.querySelector('.menu-trigger')?.textContent.trim() === 'Settings',
    )
    click(settings?.querySelector('.menu-trigger'))
    click(
      await until('Chat mode menu item', () =>
        [...settings.querySelectorAll('[role="menuitem"]')].find((b) =>
          b.textContent.startsWith('Chat mode'),
        ),
      ),
    )
  }
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
    ])
    await smoke.syncCurrentRoots()
    await smoke.refreshTasks()
    const task = await smoke.taskAttach(`${parent}/feature`, 'Simple feature', ['app'])
    await smoke.refreshTasks()
    state().setActiveTask(task.id, true)
    assert(!state().simpleMode, 'Simple must default off')
    for (const previous of ['plan', 'navigation', 'implementation', 'review']) {
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
      if (previous !== 'navigation')
        assert(
          !document.querySelector('.navigation-shell'),
          `Navigation mounted behind ${previous}`,
        )
    }
    state().setView('review')
    await toggleSimple()
    await until('chat', () => document.querySelector('.simple-chat'))
    assert(state().view === 'review', 'Simple lost the last Full view')
    assert(!document.querySelector('.view-switcher button'), 'Full switcher visible in Simple')
    assert(
      document.querySelector('.toolbar .toolbar-mode')?.textContent === 'Chat mode',
      'toolbar lacks the Chat mode label',
    )
    assert(!document.querySelector('.toolbar .simple-stage-tabs'), 'stage tabs in the toolbar')
    const stageTab = (name) =>
      [...document.querySelectorAll('.simple-chat .simple-stage-tabs button')].find((b) =>
        b.textContent.startsWith(name),
      )
    click(stageTab('Review'))
    await until('Review stage filter', () => {
      const shown = [...document.querySelectorAll('.simple-stage > h2')].map((h) => h.textContent)
      return shown.length === 1 && shown[0] === 'Review'
    })
    click(stageTab('All'))
    await until('every stage shown', () => document.querySelectorAll('.simple-stage').length === 4)
    const canvas = document.querySelector('.navigation-shell .react-flow')
    assert(canvas, 'map missing')
    await send('  hello mail@example.test\nsecond line  ')
    await until('first delivered prompt', () =>
      state().simple?.log.some((e) => e.kind === 'prompt'),
    )
    const prompt = state().simple.log.find((e) => e.kind === 'prompt')
    assert(prompt.text === '  hello mail@example.test\nsecond line  ', 'prompt text was rewritten')
    const planner = prompt.sessionId
    await until('saved plan card', () => button('Implement') && !button('Implement').disabled)
    click(button('Implement'))
    await until('Implement completion', () =>
      state().simple?.log.some((e) => e.action === 'implement'),
    )
    assert(state().simpleMode, 'Implement left Simple')
    const implementation = state().simple.log.find((e) => e.action === 'implement').sessionId
    await until('activity hydration', () => state().sessions[implementation]?.activity?.length)
    await until('file card', () => document.querySelector('.simple-file'))
    click(document.querySelector('.simple-file'))
    await until('left diff', () => document.querySelector('.simple-diff .diff'))
    assert(document.querySelector('.navigation-shell .react-flow') === canvas, 'diff remounted map')
    click(button('← Map'))
    await until('map restored', () => !document.querySelector('.simple-diff'))
    click(button('Review…'))
    const review = await until('review dialog', () =>
      document.querySelector('form[aria-label="Start review agent"]'),
    )
    await until('review ready', () => !review.querySelector('button[type="submit"]').disabled)
    review.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await until('review dispatch logged', () =>
      state().simple?.log.some((e) => e.action === 'review'),
    )
    await until(
      'Findings Fix enabled',
      () => button('Fix findings') && !button('Fix findings').disabled,
    )
    click(button('Fix findings'))
    await until('fix dispatch', () => state().simple?.log.some((e) => e.action === 'fix'))
    const fix = state().simple.log.find((e) => e.action === 'fix').sessionId
    assert(state().simpleMode, 'Fix left Simple')
    input(document.querySelector('[aria-label="Message agent"]'), 'worktree draft')
    state().setActiveTask(null, true)
    await until(
      'project chat',
      () => document.querySelector('[aria-label="Message agent"]')?.value === '',
    )
    assert(!state().simple?.log.length, 'worktree history leaked to project chat')
    state().setActiveTask(task.id, true)
    await until(
      'draft restored',
      () => document.querySelector('[aria-label="Message agent"]')?.value === 'worktree draft',
    )
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
    await until(
      'Full Implementation shortcut',
      () => !state().simpleMode && state().view === 'implementation',
    )
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
      'PASS simple: toggle, composer, Implement, diff, Review/Fix, activity, worktree drafts, and Full session recovery',
    )
  } catch (e) {
    await smoke.report(
      `FAIL simple: ${e.message} ${e.stack || ''} visibility=${document.visibilityState} plan=${JSON.stringify(await smoke.planRead(state().project.id))} chat=${document.querySelector('.simple-chat')?.innerText.slice(0, 1000)}`,
    )
  }
})()
