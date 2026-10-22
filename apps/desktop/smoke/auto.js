;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check, timeout = 90000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (ok, text) => {
    if (!ok) throw new Error(text)
  }
  const smoke = await until('smoke handles', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    await until('restore', () => !state().restoring && state().serviceConnected)
    const settings = await until('Settings menu', () =>
      [...document.querySelectorAll('.menu-trigger')].find((b) => b.textContent === 'Settings'),
    )
    settings.click()
    const notifications = await until('Notifications menu without a project', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Notifications'),
    )
    assert(!notifications.disabled, 'Notifications requires a project')
    notifications.click()
    const panel = await until('Notifications panel', () =>
      document.querySelector('[role="dialog"][aria-label="Notifications"]'),
    )
    const toggles = [...panel.querySelectorAll('input[type="checkbox"]')]
    assert(toggles.length === 4, 'Missing notification settings')
    toggles[0].click()
    await until('notifications disabled', () => !state().notifications.enabled)
    assert(
      toggles.slice(1).every((input) => input.matches(':disabled')),
      'Event controls remain enabled',
    )
    toggles[0].click()
    await until('notifications enabled', () => state().notifications.enabled)
    for (const [index, key] of ['finished', 'needsInput', 'failed'].entries()) {
      toggles[index + 1].click()
      await until(`${key} disabled`, () => !state().notifications[key])
      assert(
        smoke.workspaceDocument().settings.notifications[key] === false,
        'Setting not persisted',
      )
      toggles[index + 1].click()
      await until(`${key} enabled`, () => state().notifications[key])
    }
    ;[...panel.querySelectorAll('button')]
      .find((b) => b.textContent === 'Send test notification')
      .click()
    await until('test notification recorded', () => smoke.notificationLog.length > 0)
    ;[...panel.querySelectorAll('button')].find((b) => b.textContent === 'Close').click()
    smoke.notificationLog.length = 0
    await smoke.agentHooksConfigure('codex', true)
    smoke.acceptOpened(await smoke.openProject())
    const projectId = state().project.id
    state().setMessage('Notification regression: keep this error')
    const notificationSid = smoke.sessionId('root', 'validate')
    state().setNotificationToast({
      message: 'Agent finished — notification fixture',
      sessions: [{ sid: notificationSid, label: 'Root' }],
    })
    await until('independent notification toast', () =>
      document.querySelector('[aria-label="Dismiss notification"]'),
    )
    assert(
      document.querySelector('.toast-region').textContent.includes('keep this error'),
      'Notification replaced the persistent error',
    )
    // A tracked link whose session no longer shows that event drops out; an untracked one stays.
    state().setNotificationToast({
      message: 'Agent finished — stale fixture',
      sessions: [{ sid: 'stale-session', label: 'Stale', kind: 'finished', atMs: Date.now() }],
    })
    await until(
      'stale notification link dropped',
      () =>
        state().notificationToast?.sessions.length === 1 &&
        state().notificationToast.sessions[0].sid === notificationSid,
    )
    document.querySelector('[aria-label="Dismiss notification"]').click()
    await until('notification dismissed', () => !state().notificationToast)
    assert(
      state().message === 'Notification regression: keep this error',
      'Dismissing notification cleared the persistent error',
    )
    const plannerNotificationSid = smoke.sessionId(
      '@plan',
      state().devices.find((d) => d.kind === 'agent')?.id ?? 'claude',
    )
    state().setNotificationToast({
      message: 'Root needs input',
      sessions: [{ sid: notificationSid, label: 'Root', message: 'Root needs input' }],
    })
    // A later batch must retain the first unread link even if native delivery was suppressed.
    state().setNotificationToast({
      message: 'Planner finished',
      sessions: [{ sid: plannerNotificationSid, label: 'Planner', message: 'Planner finished' }],
    })
    await until(
      'both unread notification links',
      () => document.querySelectorAll('.toast-text button').length === 2,
    )
    const notificationMessage = document.querySelector('.notification-message')
    assert(
      notificationMessage.textContent.includes('\n'),
      'Notification lines lost their separator',
    )
    assert(
      getComputedStyle(notificationMessage).whiteSpace === 'pre-line',
      'Notification lines collapse when rendered',
    )
    const viewNotification = await until('notification session link', () =>
      [...document.querySelectorAll('.toast button')].find((b) => b.textContent === 'View Root'),
    )
    viewNotification.click()
    await until(
      'notification reveals its session',
      () => state().view === 'implementation' && state().activeSession === notificationSid,
    )
    await until(
      'viewing one notification retains the other link',
      () =>
        state().notificationToast?.sessions.length === 1 &&
        [...document.querySelectorAll('.toast button')].some(
          (b) => b.textContent === 'View Planner',
        ),
    )
    assert(
      state().notificationToast.sessions[0].sid === plannerNotificationSid,
      'Viewing Root cleared the Planner notification',
    )
    assert(
      state().message === 'Notification regression: keep this error',
      'Following notification cleared the persistent error',
    )
    document.querySelector('[aria-label="Dismiss notification"]').click()
    await until('remaining notification dismissed', () => !state().notificationToast)
    // An alert left with no links hides itself.
    state().setNotificationToast({
      message: 'Agent finished — stale fixture',
      sessions: [{ sid: 'stale-session', label: 'Stale', kind: 'finished', atMs: Date.now() }],
    })
    await until('alert without current links hidden', () => !state().notificationToast)
    state().setMessage('')
    const trees = await smoke.gitWorktrees()
    const source = trees.find((w) => w.branch === 'feature')
    const task = await smoke.taskAttach(source.path, 'Auto fixture', [])
    await smoke.refreshTasks()
    state().setActiveTask(task.id)
    state().setView('review')
    const fixtureDir = state().project.root.replace(/\/project$/, '')
    smoke.store.setState({ devices: [] })
    const autoButton = await until('Auto button', () =>
      document.querySelector('button[title="Auto mode"]'),
    )
    autoButton.click()
    await until('Auto dialog before presets load', () =>
      document.querySelector('.auto-content select'),
    )
    smoke.store.setState({
      devices: [
        {
          id: 'auto-fixture',
          name: 'Auto fixture',
          command: `'${fixtureDir}/codex'`,
          kind: 'agent',
          adapter: 'codex',
          category: 'agent',
          source: 'user',
        },
      ],
    })
    await until('Start enabled after presets arrive', () => {
      const start = [...document.querySelectorAll('.auto-content button')].find(
        (b) => b.textContent === 'Start',
      )
      return start && !start.disabled
    })
    assert(
      [...document.querySelectorAll('.auto-content select')].some(
        (s) => s.value === 'auto-fixture',
      ),
      'Loaded preset was not selected',
    )
    autoButton.click()
    const stages = []
    const unsubscribe = smoke.store.subscribe((s) => {
      if (s.auto && stages.at(-1) !== s.auto.stage) stages.push(s.auto.stage)
    })
    await smoke.startAuto(projectId, task.id, {
      goal: 'Finish the fixture task',
      effort: 'light',
      device: 'auto-fixture',
      merge: { mode: 'ask', destinationBranch: 'main' },
    })
    await until('merge approval', () => {
      if (['failed', 'paused'].includes(state().auto?.status)) throw new Error(state().auto.reason)
      return state().auto?.stage === 'mergeGate' && state().auto.status === 'waitingOnYou'
    })
    assert(stages.join(',') === 'review,fix,review,mergeGate', `Wrong stage sequence ${stages}`)
    assert(state().auto.round === 1, 'Fix budget counter did not advance')
    assert(
      smoke.attentionItems(state()).some((item) => item.auto),
      'Auto merge approval missing from attention',
    )
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent.startsWith('Auto:'),
    )
    button.click()
    const merge = await until('Merge now button', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Merge now'),
    )
    merge.click()
    await until('done', () => {
      if (['failed', 'paused'].includes(state().auto?.status)) throw new Error(state().auto.reason)
      return state().auto?.status === 'done'
    })
    unsubscribe()
    const outcome = await smoke.mergeOutcome(state().toProject(), {
      source: source.path,
      sourceBranch: 'feature',
      destination: state().project.root,
      destinationBranch: 'main',
    })
    assert(outcome === 'merged', `Wrong outcome ${outcome}`)
    assert(
      stages.join(',') === 'review,fix,review,mergeGate,merge,done',
      `Wrong full sequence ${stages}`,
    )
    const layout = smoke.workspaceDocument().projects[0].layout
    assert(smoke.restoredLayout(layout).auto.status === 'done', 'Restored Auto lost its finish')
    const unfinished = smoke.restoredLayout({
      ...layout,
      auto: { ...layout.auto, status: 'running' },
    })
    assert(unfinished.auto.status === 'paused', 'Restored Auto continued without approval')
    const description = await smoke.taskCreate({
      title: 'Description fixture',
      branch: 'auto-description',
      base: 'main',
      components: [],
    })
    await smoke.refreshTasks()
    state().setActiveTask(description.id)
    const descriptionStages = []
    const unsubscribeDescription = smoke.store.subscribe((s) => {
      if (s.auto && descriptionStages.at(-1) !== s.auto.stage) descriptionStages.push(s.auto.stage)
    })
    await smoke.startAuto(projectId, description.id, {
      goal: 'Finish the fixture task',
      effort: 'standard',
      device: 'auto-fixture',
      merge: { mode: 'auto', destinationBranch: 'main' },
    })
    await until('description to automatic merge', () => {
      if (['failed', 'paused', 'waitingOnYou'].includes(state().auto?.status))
        throw new Error(state().auto.reason)
      return state().auto?.status === 'done'
    })
    unsubscribeDescription()
    assert(
      descriptionStages.join(',') === 'plan,implement,validate,review,mergeGate,merge,done',
      `Wrong description sequence ${descriptionStages}`,
    )
    assert(
      state().auto.validation.length === 1 &&
        state().auto.validation[0].results.every((r) => r.outcome === 'passed'),
      'Affected validation did not run and pass',
    )
    await smoke.report(
      'PASS Auto: review → fix → review → approval → merge → done; native Codex P-tag conversion and process exit, authoritative turns, scoped commit, attention, verified Git outcome, delayed presets, paused restore, description planning/implementation/affected validation and automatic merge',
    )
  } catch (e) {
    await smoke.report(
      `FAIL Auto: ${e.message ?? e} ${e.stack ?? ''} ${JSON.stringify(state().auto)}`,
    )
  }
})()
