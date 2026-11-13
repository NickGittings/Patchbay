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
    await until('bootstrap status', () =>
      document.querySelector('.simple-composer').textContent.includes('Starting Lead · Codex…'),
    )
    await until('persistent agent', () => team()?.lead.sessionId)
    const lead = team().lead.sessionId
    assert(
      document.querySelector('.chat-recipient').textContent.includes('Talking to Lead · Codex'),
      'Composer does not identify the durable lead',
    )
    const jobs = () =>
      smoke.chatTeams
        .getState()
        .runs[projectId]?.filter((r) => r.chatTeam === team()?.id)
        .flatMap((r) => r.jobs) ?? []
    await until(
      'isolated workers',
      () => jobs().length === 2 && jobs().every((j) => j.task && j.sessionId),
    )
    assert(
      state().simple.log.filter((e) => e.kind === 'prompt' && e.text === 'delegate-fixture')
        .length === 1,
      'First user draft was duplicated',
    )
    assert(
      !state().simple.log.some((e) => e.kind === 'reply' && e.text === 'Ready'),
      'Internal bootstrap entered chat history',
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
      assignments.textContent.includes('Use the Chat menu') &&
        !['Pause', 'Resume', 'Stop', 'Retry'].some((text) => button(text, assignments)),
      'Full view exposed manual controls for chat-owned assignments',
    )
    await until('worker results retained in background', () => jobs().every((j) => j.summary))
    state().setSimpleMode(true)
    await until('chat restored', () => document.querySelector('[aria-label="Work status"]'))
    assert(state().simple.selectedAgent === team().lead.sessionId, 'lead selection lost')
    assert(
      !document.querySelector('.simple-thread').textContent.includes('WORKER-SIDE-THREAD-ONLY'),
      'worker reply entered main transcript',
    )
    assert(!document.querySelector('.chat-workers'), 'Worker activity panel remains in Chat')
    assert(!button('Open side thread'), 'Side-thread controls remain in Chat')
    const menu = document.querySelector('.chat-menu')
    menu.open = true
    button('Pause work', menu).click()
    await until('paused team', () => team().state === 'paused')
    const send = async (text) => {
      input(document.querySelector('[aria-label="Message agent"]'), text)
      const submit = await until('message enabled', () => {
        const b = button('Send') ?? button('Queue')
        return b && !b.disabled && b
      })
      submit.click()
      await until('message delivered', () =>
        state().simple.log.some((e) => e.kind === 'prompt' && e.text === text),
      )
    }
    await send('ask-fixture')
    await until('durable information request', () => team().informationRequests?.length === 1)
    assert(!team().informationRequests[0].response, 'Paused scheduling delivered a worker request')
    assert(team().state === 'paused', 'Lead messaging resumed worker scheduling')
    button('Continue work', menu).click()
    await until('resumed team', () => team().state === 'running')
    await until('existing agent response', () => team().informationRequests[0].response)
    await until('lead synthesis', () =>
      document
        .querySelector('.simple-thread')
        .textContent.includes('I gathered the existing agent'),
    )
    assert(jobs().length === 2, 'Gathering information launched a duplicate worker')
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
    assert(
      !document.querySelector('[aria-label="Work status"]'),
      'another worktree showed the first team',
    )
    assert(!state().simple?.selectedAgent, 'another worktree inherited the lead')
    state().setActiveTask(null)
    await until('original worktree team', () =>
      document.querySelector('[aria-label="Work status"]'),
    )
    document.querySelector('.chat-menu').open = true
    button('Stop work', document.querySelector('.chat-menu')).click()
    await until('stopped team', () => team().state === 'stopped')
    assert(
      jobs().every((j) => j.task && j.summary),
      'Stop discarded worktrees or completed results',
    )
    // Send recovers the missing durable lead without requiring an intentional agent switch.
    const transcript = state().simple.log.map((e) => e.id)
    const missingLead = team().lead.sessionId
    await smoke.terminalStop(missingLead)
    await until('lead stopped', async () => !(await smoke.terminalSnapshot(missingLead))?.running)
    await smoke.sessionForget(missingLead)
    await smoke.reconcileSessions()
    await until(
      'lead record forgotten',
      () => !state().sessionRecords.some((r) => r.id === missingLead),
    )
    await send('Continue after the forgotten lead')
    await until('reconstructed lead', () => team().lead.sessionId !== missingLead && !team().reset)
    const replacement = state().sessionRecords.find((r) => r.id === team().lead.sessionId)
    assert(replacement, 'Recovered lead has no session record')
    assert(
      state().rootTerminals.some((t) => t.id === replacement.metadata.terminalId),
      'Recovered terminal was not registered',
    )
    assert(team().state === 'stopped', 'Recovery discarded the explicit stop decision')
    assert(
      transcript.every((id) => state().simple.log.some((e) => e.id === id)),
      'Recovery cleared the conversation',
    )
    assert(
      state().simple.log.some(
        (e) => e.text === 'Context restored from the saved conversation and team state.',
      ),
      'Recovery notice missing',
    )
    const generation = team().lead.generation
    const conversation = team().lead.conversation
    await smoke.terminalStop(replacement.id)
    await until(
      'replacement stopped',
      async () => !(await smoke.terminalSnapshot(replacement.id))?.running,
    )
    await smoke.reconcileSessions()
    await send('Resume the exact conversation')
    assert(team().lead.sessionId === replacement.id, 'Exact resume changed the session')
    assert(team().lead.generation > generation, 'Stopped lead was not resumed')
    await until('exact provider identity', () => team().lead.conversation === conversation)
    const resumedGeneration = team().lead.generation
    await send('erase-history-fixture')
    await until('history erased', () =>
      document
        .querySelector('.simple-thread')
        .textContent.includes('History removed for recovery verification.'),
    )
    await smoke.terminalStop(replacement.id)
    await until(
      'stopped without provider history',
      async () => !(await smoke.terminalSnapshot(replacement.id))?.running,
    )
    await smoke.reconcileSessions()
    await send('Continue without provider history')
    assert(
      team().lead.sessionId === replacement.id,
      'Missing-history reconstruction changed the retained session',
    )
    assert(
      team().lead.generation > resumedGeneration,
      'Missing history did not reconstruct context',
    )
    for (const text of [
      'Continue after the forgotten lead',
      'Resume the exact conversation',
      'Continue without provider history',
    ]) {
      assert(
        state().simple.log.filter((e) => e.kind === 'prompt' && e.text === text).length === 1,
        `Duplicate or missing message: ${text}`,
      )
    }
    smoke.simpleUi
      .getState()
      .patch(smoke.simpleKey(projectId, null), { draft: 'Draft preserved across app restart' })
    await smoke.flushWorkspace()
    await smoke.report(
      'PASS coordinated chat: continuous lead, existing-agent information requests, isolated workers, chat-menu controls, retained history/results, automatic forgotten-lead recovery, exact resume, missing-history reconstruction and single delivery',
    )
  } catch (e) {
    await smoke.report(
      `FAIL coordinated chat: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
