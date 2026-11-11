// Real session transport and authenticated team commands, with disposable provider stand-ins.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(80)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (value, text) => {
    if (!value) throw new Error(text)
  }
  const button = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const input = (el, value, event = 'input') => {
    assert(el, 'missing input')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event(event, { bubbles: true }))
  }
  try {
    await smoke.resizeWindow(1440, 900)
    smoke.acceptOpened(await smoke.openProject())
    const projectId = state().project.id
    const parent = state().project.root.replace(/\/project$/, '')
    state().setDevices([
      {
        id: 'team-agent',
        name: 'Team agent',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
        adapter: 'codex',
        command: `'${parent}/codex'`,
      },
    ])
    await smoke.agentHooksConfigure('codex', true)
    await smoke.syncCurrentRoots()
    state().setSimpleMode(true)
    input(
      await until('lead picker', () => document.querySelector('[aria-label="Chat lead"]')),
      'preset:team-agent',
      'change',
    )
    const team = () => smoke.chatTeams.getState().teams[projectId]?.find((t) => t.task === null)
    await until('persistent lead', () => team()?.lead.sessionId)
    // A draft makes the Send control available; readiness is confirmed by the session hook.
    const lead = team().lead.sessionId
    await until('ready lead', () =>
      ['idle', 'review'].includes(state().sessions[lead]?.status?.agent?.state),
    )
    input(document.querySelector('[aria-label="Message agent"]'), 'delegate-fixture')
    await until('send enabled', () => button('Send') && !button('Send').disabled)
    button('Send').click()
    const jobs = () =>
      smoke.chatTeams
        .getState()
        .runs[projectId]?.filter((r) => r.chatTeam === team()?.id)
        .flatMap((r) => r.jobs) ?? []
    await until(
      'isolated workers',
      () => jobs().length === 2 && jobs().every((j) => j.task && j.sessionId),
    )
    const round = smoke.chatTeams.getState().runs[projectId].find((r) => r.chatTeam === team().id)
    for (const control of [
      { kind: 'pause' },
      { kind: 'stop' },
      { kind: 'retry', job: jobs()[0].id },
    ]) {
      let rejected = false
      try {
        await smoke.controlProviderRun(projectId, round.id, control)
      } catch (error) {
        rejected = String(error).includes('Chat worker controls')
      }
      assert(rejected, `Manual provider ${control.kind} bypassed chat team ownership`)
    }
    const originalGeneration = team().lead.generation
    ;(
      await until('clear conversation enabled', () => {
        const b = button('Clear conversation')
        return b && !b.disabled && b
      })
    ).click()
    await until('new lead conversation', () => team()?.lead.generation > originalGeneration)
    state().setSimpleMode(false)
    state().setView('implementation')
    const assignments = await until('read-only chat assignments in Full view', () =>
      document.querySelector('[aria-label="Implementation assignments"]'),
    )
    assert(
      assignments.textContent.includes('Use Worker activity in Chat') &&
        !['Pause', 'Resume', 'Stop', 'Retry'].some((text) => button(text, assignments)),
      'Full view exposed manual controls for chat-owned assignments',
    )
    await until('worker results retained in background', () => jobs().every((j) => j.summary))
    state().setSimpleMode(true)
    await until('chat restored', () => document.querySelector('.chat-workers'))
    assert(state().simple.selectedAgent === team().lead.sessionId, 'lead selection lost')
    assert(
      !document.querySelector('.simple-thread').textContent.includes('WORKER-SIDE-THREAD-ONLY'),
      'worker reply entered main transcript',
    )
    const activity = document.querySelector('.chat-workers')
    activity.open = true
    button('Pause', activity).click()
    await until('paused team', () => team().state === 'paused')
    const worker = [...activity.querySelectorAll('.chat-worker')][0]
    button('Open side thread', worker).click()
    await until('side thread', () => worker.querySelector('textarea'))
    input(worker.querySelector('textarea'), 'Keep the baseline in your report')
    button('Send to worker and copy lead', worker).click()
    await until(
      'copied side message',
      () => team().messages.filter((m) => m.sender === 'user').length === 2,
    )
    assert(
      team()
        .messages.filter((m) => m.sender === 'user')
        .every((m) => m.state === 'pending'),
      'paused team delivered a message',
    )
    button('Resume', activity).click()
    await until('resumed team', () => team().state === 'running')
    await until('side message delivered', () =>
      team()
        .messages.filter((m) => m.sender === 'user')
        .every((m) => m.state === 'delivered'),
    )
    button('Clear visible history').click()
    button(
      'Clear',
      await until('clear confirmation', () => document.querySelector('.simple-clear-confirm')),
    ).click()
    assert(
      jobs().every((j) => j.summary),
      'visible clear erased worker results',
    )
    await smoke.createTask({ title: 'Other chat', branch: 'other-chat', components: ['app'] })
    await until('other worktree', () => state().activeTask !== null)
    assert(!document.querySelector('.chat-workers'), 'another worktree showed the first team')
    assert(!state().simple?.selectedAgent, 'another worktree inherited the lead')
    state().setActiveTask(null)
    await until('original worktree team', () => document.querySelector('.chat-workers'))
    button('Stop workers', document.querySelector('.chat-workers')).click()
    await until('stopped team', () => team().state === 'stopped')
    assert(
      jobs().every((j) => j.task && j.summary),
      'Stop discarded worktrees or completed results',
    )
    await smoke.report(
      'PASS coordinated chat: persistent lead, isolated report/code workers, fresh conversation, side threads, pause/resume, both clear actions and retained results',
    )
  } catch (e) {
    await smoke.report(
      `FAIL coordinated chat: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
