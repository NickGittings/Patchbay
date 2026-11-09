// Independent planners, clearing during a live turn, usage and draft handoff in disposable repos.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check, timeout = 35000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(30)
      const result = await check()
      if (result) return result
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const button = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const input = (el, value) => {
    assert(el, 'missing input')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const text = () => document.querySelector('.simple-thread')?.textContent ?? ''
  const draft = '_project_draft'
  let phase = 'open fixture'
  try {
    await smoke.resizeWindow(1440, 900)
    await until('restore', () => !state().restoring && state().serviceConnected)
    smoke.acceptOpened(await smoke.openProject())
    const pid = state().project.id
    const parent = state().project.root.replace(/\/project$/, '')
    const fake = {
      id: 'scoped-codex',
      name: 'Scoped Codex',
      adapter: 'codex',
      command: `'${parent}/codex'`,
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
    }
    state().setDevices([fake])
    state().setAgentRoles({ plan: [fake.id], implement: [fake.id] })
    await smoke.agentHooksConfigure('codex', true)
    await smoke.syncCurrentRoots()
    phase = 'create first worktree'
    const first = await smoke.createTask({
      title: 'First scope',
      branch: 'first-scope',
      components: ['app'],
    })
    phase = 'create sibling worktree'
    const sibling = await smoke.createTask({
      title: 'Sibling scope',
      branch: 'sibling-scope',
      components: [],
    })
    phase = 'first planner and Clear'
    state().setActiveTask(first.id)
    state().setSimpleMode(true)
    await until('first chat', () => document.querySelector('.simple-chat'))
    input(document.querySelector('[aria-label="Message agent"]'), 'Original prompt to clear')
    ;(
      await until('Start ready', () => {
        const b = button('Start')
        return b && !b.disabled && b
      })
    ).click()
    const sid = smoke.sessionId('@plan', fake.id, first.id)
    await until(
      'first planner working',
      () => state().sessions[sid]?.status?.agent?.state === 'working',
    )
    button('Clear chat').click()
    const confirm = await until('clear confirmation', () =>
      document.querySelector('.simple-clear-confirm'),
    )
    button('Cancel', confirm).click()
    assert(
      state().simple.log.some((e) => e.text === 'Original prompt to clear'),
      'Cancel cleared history',
    )
    input(
      document.querySelector('[aria-label="Message agent"]'),
      'Queued message survives clearing',
    )
    ;(
      await until('Queue ready', () => {
        const b = button('Queue')
        return b && !b.disabled && b
      })
    ).click()
    const chatKey = smoke.simpleKey(pid, first.id)
    const queued = smoke.simpleUi.getState().worktrees[chatKey].queued
    assert(queued, 'message was not queued')
    button('Clear chat').click()
    const confirm2 = await until('second clear confirmation', () =>
      document.querySelector('.simple-clear-confirm'),
    )
    smoke.simpleUi.getState().patch(chatKey, { pendingAction: true })
    await until('confirmation guard', () => button('Clear', confirm2).disabled)
    button('Clear', confirm2).click()
    assert(state().simple.log.length > 0, 'pending action bypassed guard')
    smoke.simpleUi.getState().patch(chatKey, { pendingAction: false })
    await until('confirmation enabled', () => !button('Clear', confirm2).disabled)
    button('Clear', confirm2).click()
    await until(
      'history cleared',
      () => state().simple.log.length === 0 && state().simple.clearBoundary,
    )
    assert(
      smoke.simpleUi.getState().worktrees[chatKey].queued === queued,
      'clear changed the queued message',
    )
    assert(state().sessions[sid].running, 'clear stopped the planner')
    assert(!text().includes('Original prompt to clear'), 'cleared prompt is visible')
    await until(
      'new reply and queue delivery',
      () =>
        text().includes('I planned the') && !smoke.simpleUi.getState().worktrees[chatKey].queued,
    )
    await smoke.reconcileSessions(false)
    assert(
      !state().simple.log.some((e) => e.text === 'Original prompt to clear'),
      'reconcile replayed the cleared prompt',
    )
    assert(
      (await smoke.planRead(pid, first.id)).text.includes('Simple fixture plan'),
      'clear removed the plan',
    )
    phase = 'sibling planner'
    state().setActiveTask(sibling.id)
    await until('sibling chat', () => !text().includes('I planned the'))
    assert(!(await smoke.planRead(pid, sibling.id)).text.trim(), 'sibling inherited another plan')
    await smoke.startTerminal('@plan', fake.id, sibling.id, pid)
    const siblingSid = smoke.sessionId('@plan', fake.id, sibling.id)
    await until(
      'concurrent same-provider planners',
      () => state().sessions[sid]?.running && state().sessions[siblingSid]?.running,
    )
    await smoke.reconcileSessions(false)
    const record = state().sessionRecords.find((r) => r.id === siblingSid)
    assert(
      record.metadata.task === sibling.id && record.spec.cwd === sibling.worktree,
      'planner ran in another checkout',
    )
    phase = 'usage warnings'
    // Usage is visible with notifications and Auto gating disabled, with exact expiration.
    state().setNotifications({ ...state().notifications, enabled: false, usageLimits: false })
    state().setUsageSettings({ ...state().usageSettings, gateAuto: false })
    const reset = Date.now() + 1800
    const usageSnapshot = {
      codex: {
        fiveHour: { usedPercent: 100, resetsAtMs: reset },
        weekly: { usedPercent: 105, resetsAtMs: Date.now() + 120000 },
      },
      claude: null,
    }
    const stopUsageFixture = smoke.usage.subscribe((s) => {
      if (s.usage !== usageSnapshot) smoke.usage.setState({ usage: usageSnapshot })
    })
    smoke.usage.setState({ usage: usageSnapshot })
    await until(
      'all exhausted windows',
      () => document.querySelectorAll('.simple-usage-warning').length === 2,
    )
    assert(
      document.querySelector('.simple-composer-controls button').disabled === false,
      'usage disabled terminal access',
    )
    await until(
      'expired window removed',
      () => document.querySelectorAll('.simple-usage-warning').length === 1,
    )
    stopUsageFixture()
    phase = 'draft handoff'
    // Draft plans save pending editor changes, require a stopped source and transfer history.
    state().setSimpleMode(false)
    state().setView('plan')
    const select = await until('scope selector', () =>
      document.querySelector('[aria-label="Planning scope"]'),
    )
    select.value = 'draft'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await smoke.startTerminal('@plan', fake.id, draft, pid)
    const draftSid = smoke.sessionId('@plan', fake.id, draft)
    await until(
      'draft planner ready',
      () => state().sessions[draftSid]?.status?.agent?.state === 'idle',
    )
    await smoke.terminalWrite(draftSid, 'draft conversation\n')
    await until('draft plan', async () =>
      (await smoke.planRead(pid, draft)).text.includes('Simple fixture plan'),
    )
    const draftWorkspace = state().taskWorkspaces[draft]
    state().patchTask(pid, draft, {
      simple: { ...draftWorkspace.simple, clearBoundary: { atMs: 1, runs: [] } },
      planStory: null,
    })
    const boundary = state().taskWorkspaces[draft].simple.clearBoundary
    const details = document.querySelector('.plan-file')
    if (!details.open) details.querySelector('summary').click()
    const editor = await until('draft editor', () => {
      const e = details.querySelector('textarea')
      return e && !e.disabled && e
    })
    input(editor, '# Unsaved editor handoff\n\nKeep scope independent.')
    button('＋ New task').click()
    const dialog = await until('new worktree dialog', () =>
      document.querySelector('form[aria-label="New task"]'),
    )
    input(dialog.querySelector('input'), 'Draft handoff')
    ;(
      await until('create ready', () => {
        const b = dialog.querySelector('button[type="submit"]')
        return !b.disabled && b
      })
    ).click()
    await until('running source rejected', () =>
      dialog.textContent.includes('stop the project draft planner'),
    )
    await smoke.terminalStop(draftSid)
    await until('draft source stopped', () => !state().sessions[draftSid]?.running)
    dialog.querySelector('button[type="submit"]').click()
    await until(
      'draft transfer completed',
      () =>
        state().activeTask !== sibling.id &&
        state().taskWorkspaces[draft].simple?.log.length === 0 &&
        state().taskWorkspaces[draft].simple?.clearBoundary,
    )
    const destination = state().activeTask
    assert(
      (await smoke.planRead(pid, destination)).text.includes('Unsaved editor handoff'),
      'pending editor changes were lost',
    )
    assert(
      JSON.stringify(state().simple.clearBoundary) === JSON.stringify(boundary),
      'clear boundary was lost',
    )
    assert(!(await smoke.planRead(pid, draft)).text.trim(), 'source draft was not cleared')
    assert(
      state().simple.log.some((e) => e.kind === 'reply'),
      'conversation history was not transferred',
    )
    assert(
      state().sessions[sid]?.running && state().sessions[siblingSid]?.running,
      'handoff disturbed sibling planners',
    )
    await smoke.reconcileSessions(false)
    assert(
      state().taskWorkspaces[draft].simple.log.length === 0,
      'source snapshot replayed transferred history',
    )
    state().setSimpleMode(true)
    state().revealChat({ projectId: pid, task: destination })
    await until('transferred plan can Build', () => button('Build'))
    await smoke.startTerminal('@plan', fake.id, destination, pid)
    const destinationSid = smoke.sessionId('@plan', fake.id, destination)
    await until('fresh destination planner', () => state().sessions[destinationSid]?.running)
    assert(destinationSid !== draftSid, 'handoff reused the source provider session')
    await smoke.report(
      'PASS planning: concurrent worktree planners, active-turn Clear/cancel/guard/replay, queued delivery, usage expiration, unsaved draft handoff and preserved history boundary',
    )
  } catch (e) {
    await smoke.report(
      `FAIL planning (${phase}): ${String(e)}; message=${state().message}; ${e.stack ?? ''}`,
    )
  }
})()
