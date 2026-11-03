// Discovery submits through its authenticated terminal, then review applies and runs checks.
;(async () => {
  const until = async (what, check) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`Timed out: ${what}`)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const button = (text) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  try {
    const opened = await smoke.openProject()
    smoke.resetSessions(await smoke.terminalReset())
    state().loadProject({
      ...opened.project,
      components: [
        {
          id: 'api',
          name: 'API',
          path: '.',
          kind: 'service',
          notes: '',
          terminals: [],
          position: { x: 0, y: 0 },
        },
        {
          id: 'web',
          name: 'Web',
          path: '.',
          kind: 'service',
          notes: '',
          terminals: [],
          position: { x: 350, y: 0 },
        },
      ],
      links: [{ id: 'web-api', source: 'web', target: 'api' }],
      groups: [],
    })
    await smoke.syncAgentProject(state().toProject())
    const proposal = {
      version: 1,
      terminals: [
        {
          component: 'api',
          path: '.',
          terminal: null,
          name: 'Tests',
          command: 'exit 3',
          reason: 'README.md:1 fixture failure',
        },
      ],
      missing: [],
    }
    state().setDevices([
      {
        id: 'validation-fixture',
        name: 'Validation fixture',
        category: 'agent',
        kind: 'agent',
        source: 'builtin',
        command: `printf '%s' '${JSON.stringify(proposal)}' | "$PATCHBAY_CLI" agent propose-validation --file -; exec cat`,
      },
    ])
    smoke.selectPanel('activity')
    ;(
      await until('setup available without terminals', () =>
        button('Configure checks with an agent…'),
      )
    ).click()
    const api = await until('component picker', () =>
      [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'API'),
    )
    api.querySelector('input').click()
    ;(await until('discovery', () => button('Discover checks'))).click()
    const sid = smoke.sessionId('@map', 'validation-discovery', null)
    await until('authenticated submission', () =>
      smoke.terminalText(sid).text.replace(/\s+/g, '').includes('"submitted":1'),
    )
    smoke.stopTerminal(sid)
    await until('discovery exited', () => state().sessions[sid]?.running === false)
    // A reload loses the frontend's selection cache. Exercise the ordinary dock/
    // Sessions restart path with the same empty request, without resuming an agent.
    const originalFetch = window.fetch
    const startUrl = window.__TAURI_INTERNALS__.convertFileSrc('validation_agent_start', 'ipc')
    let recoveredSelection = false
    window.fetch = (input, options) => {
      if (String(input) === startUrl) {
        const body = JSON.parse(options.body)
        if (body.resume !== false) throw new Error('Expected an ordinary discovery restart')
        body.componentIds = []
        options = { ...options, body: JSON.stringify(body) }
        recoveredSelection = true
      }
      return originalFetch(input, options)
    }
    try {
      const requestId = await smoke.startTerminal('@map', 'validation-discovery', null)
      if (!requestId || !recoveredSelection)
        throw new Error(`Discovery did not restart with its retained selection: ${state().message}`)
      await until('restarted discovery running', () => state().sessions[sid]?.running === true)
    } finally {
      window.fetch = originalFetch
    }
    smoke.selectPanel('activity')
    await until('evidence', () => document.body.textContent.includes('README.md:1 fixture failure'))
    ;(await until('apply and run', () => button('Apply and run'))).click()
    await until('failed report', () => state().graphActionReport?.results?.[0]?.exitCode === 3)
    const report = state().graphActionReport
    if (report.results.length !== 1 || report.plan.stages.flat().join(',') !== 'api')
      throw new Error('Validation expanded to dependents')
    if (state().nodes.find((n) => n.id === 'api').data.terminals[0]?.action !== 'validation')
      throw new Error('Failed run lost configuration')
    smoke.stopTerminal(sid)
    await smoke.report(
      'PASS validation: empty setup, selection, retained discovery restart, authenticated discovery, evidence, additive apply, scoped failed run',
    )
  } catch (error) {
    await smoke.report(`FAIL validation: ${error?.message ?? error} ${error?.stack ?? ''}`)
  }
})()
