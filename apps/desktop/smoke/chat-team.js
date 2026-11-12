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
    smoke.store.setState({
      workspaceSettings: { ...state().workspaceSettings, chatAgent: 'team-agent' },
    })
    const team = () => smoke.chatTeams.getState().teams[projectId]?.find((t) => t.task === null)
    await until('composer', () => document.querySelector('[aria-label="Message agent"]'))
    input(document.querySelector('[aria-label="Message agent"]'), 'delegate-fixture')
    await until('send enabled', () => button('Send') && !button('Send').disabled)
    button('Send').click()
    await until('persistent agent', () => team()?.lead.sessionId)
    const lead = team().lead.sessionId
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
    button('Send to worker and copy agent', worker).click()
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
    button('Clear chat').click()
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
    // A forgotten lead still belongs to its durable team and must be replaced through it.
    const missingLead = team().lead.sessionId
    await smoke.terminalStop(missingLead)
    await until('lead stopped', async () => !(await smoke.terminalSnapshot(missingLead))?.running)
    await smoke.sessionForget(missingLead)
    await smoke.reconcileSessions()
    await until(
      'lead record forgotten',
      () => !state().sessionRecords.some((r) => r.id === missingLead),
    )
    input(
      document.querySelector('[aria-label="Message agent"]'),
      'Keep this draft during replacement',
    )
    await until('missing lead recovery guidance', () =>
      document.querySelector('.chat-recipient')?.textContent.includes('Switch agent'),
    )
    assert(button('Send').disabled, 'missing lead could launch an unrelated session')
    await until('switch agent enabled', () => {
      const b = button('Switch agent…')
      return b && !b.disabled && b
    })
    button('Switch agent…').click()
    const picker = await until('switch agent picker', () =>
      document.querySelector('[aria-label="Switch chat agent"]'),
    )
    input(picker, 'team-agent', 'change')
    await until('replacement lead', () => team().lead.sessionId !== missingLead && !team().reset)
    const replacement = await until('replacement record', () =>
      state().sessionRecords.find((r) => r.id === team().lead.sessionId),
    )
    assert(
      state().rootTerminals.some((t) => t.id === replacement.metadata.terminalId),
      'replacement terminal was not registered in its workspace',
    )
    await smoke.refreshChatTeams(projectId)
    assert(state().simple.selectedAgent === replacement.id, 'refresh reselected the forgotten lead')
    assert(
      document.querySelector('[aria-label="Message agent"]').value ===
        'Keep this draft during replacement',
      'replacement discarded the draft',
    )
    const generation = state().sessions[replacement.id].generation
    await smoke.terminalStop(replacement.id)
    await until(
      'replacement stopped',
      async () => !(await smoke.terminalSnapshot(replacement.id))?.running,
    )
    await smoke.reconcileSessions()
    await smoke.startTerminal('@task', replacement.metadata.terminalId, null, projectId)
    await until('replacement restarted', async () => {
      await smoke.reconcileSessions()
      const session = state().sessions[replacement.id]
      return session?.running && session.generation > generation
    })
    await smoke.report(
      'PASS coordinated chat: persistent lead, isolated report/code workers, fresh conversation, side threads, pause/resume, both clear actions, retained results, forgotten lead recovery and replacement restart',
    )
  } catch (e) {
    await smoke.report(
      `FAIL coordinated chat: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
