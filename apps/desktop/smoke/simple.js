// A single conversation through planning, a new worktree, review, fixes and merge.
;(async () => {
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (label, check, timeout = 25000) => {
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
      command: `python3 '${parent}/agent.py'`,
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
    await until('chat', () => document.querySelector('.simple-chat'))
    assert(!document.querySelector('.simple-stage-tabs'), 'stage tabs remain')
    assert(!document.querySelector('.simple-terminal-drawer'), 'terminal starts open')
    input(document.querySelector('[aria-label="Message agent"]'), 'Plan the fixture feature')
    click(
      await until('Send ready', () => {
        const b = button('Send')
        return b && !b.disabled && b
      }),
    )
    await until('planner reply', () => chatText().includes('I planned the fixture feature'))
    await until('saved plan', () => chatText().includes('Simple fixture plan') && button('Build'))
    inChat()
    const planner = state().simple.log.find((e) => e.kind === 'prompt').sessionId
    assert(
      state().simple.log.some((e) => e.kind === 'reply' && e.sessionId === planner),
      'reply not persisted',
    )
    click(button('View Planner terminal'))
    await until('planner drawer', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"] .xterm'),
    )
    click(button('Build'))
    const dialog = await until('new worktree offered', () =>
      document.querySelector('form[aria-label="New task"]'),
    )
    input(dialog.querySelector('input'), 'Simple chat build')
    click(
      await until('create task ready', () => {
        const b = dialog.querySelector('button[type="submit"]')
        return !b.disabled && b
      }),
    )
    await until('worktree build done', () => chatText().includes('Building done.'))
    inChat()
    const task = state().activeTask
    assert(task, 'Build did not create a worktree')
    assert(
      state().simple.log.some((e) => e.kind === 'prompt' && e.sessionId === planner),
      'conversation not carried into worktree',
    )
    await until(
      'open drawer follows Builder',
      () =>
        document.querySelector('.simple-terminal-drawer[aria-label="build terminal"] .xterm') &&
        button('Hide Builder terminal'),
    )
    click(button('Hide Builder terminal'))
    await until('drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    click(button('Review'))
    await until('review findings', () => chatText().includes('1 issues found.') && button('Fix'))
    inChat()
    await until('reviewer terminal button', () => button('View Reviewer terminal'))
    click(button('View Reviewer terminal'))
    await until('reviewer drawer shows its terminal', () =>
      document.querySelector('.simple-terminal-drawer[aria-label="review terminal"] .xterm'),
    )
    click(button('Hide Reviewer terminal'))
    await until('reviewer drawer closed', () => !document.querySelector('.simple-terminal-drawer'))
    click(button('Fix'))
    await until('fix done', () => chatText().includes('Fixes done.'))
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
    // A permission wait of a planner run this chat started switches both recipient and drawer
    // to it; another chat's run of the shared planner never does.
    await smoke.startTerminal('@plan', fake.id, null, projectId)
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
    await until(
      'input opens planner drawer',
      () =>
        document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"]') &&
        chatText().includes('Allow fixture tool?'),
    )
    const drawer = document.querySelector('.simple-terminal-drawer .xterm')
    await smoke.terminalWrite(planner, 'a')
    await until(
      'first answer character changes status',
      () => state().sessions[planner]?.status?.agent?.state === 'working',
    )
    await sleep(300)
    assert(
      document.querySelector('.simple-terminal-drawer .xterm') === drawer,
      'input terminal unmounted while answering',
    )
    assert(
      document.querySelector('.simple-terminal-drawer[aria-label="plan terminal"]'),
      'drawer switched away from question',
    )
    await smoke.terminalStop(planner)
    await until('automatic drawer closes', () => !document.querySelector('.simple-terminal-drawer'))
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
      'PASS simple: one conversation, replies, plan, new worktree handoff, drawer follows agent and input waits, Review/Fix/conflicts/Merge, persisted log',
    )
  } catch (e) {
    await smoke.report(
      `FAIL simple: ${e.message} ${e.stack ?? ''} chat=${chatText().slice(-1800)} message=${state().message}`,
    )
  }
})()
