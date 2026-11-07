// Real Codex sandbox and SOCKS proxy, scripted commands; no inference or paid API calls.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const text = (sid) => smoke.terminalText(sid).text
  try {
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    await smoke.syncCurrentRoots()
    await smoke.syncAgentProject(state().toProject())
    const base = opened.project.root.replace(/\/project\/?$/, '')
    const preset = (role, extra = '') => ({
      id: `codex-network-${role}`,
      name: `Codex network ${role}`,
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: `env CODEX_HOME='${base}/${role === 'denied-named' ? 'home-named' : 'home'}' PATCHBAY_NETWORK_PROBE_ROLE=${role} '${base}/codex' ${extra}`,
    })
    const restricted = state().addRootTerminal(preset('restricted'))
    await smoke.startTerminal('@task', restricted)
    const restrictedSid = smoke.sessionId('@task', restricted, null)
    await until('original restricted TCP failure', () =>
      text(restrictedSid).includes('codex-network-finished restricted'),
    )
    const planner = preset('planner')
    state().setDevices([planner])
    smoke.selectRailView('plan')
    await until('Plan view', () => document.querySelector('.plan-scope'))
    const scope = [...state().highlighted]
    const roots = state().rootTerminals.length
    await smoke.startTerminal('@plan', planner.id)
    const plannerSid = smoke.sessionId('@plan', planner.id, null)
    await until('sandboxed proposal', () =>
      text(plannerSid).includes('codex-network-finished planner'),
    )
    await until('proposal visible in Patchbay', () => state().proposedScope.includes('web'))
    assert(
      JSON.stringify(scope) === JSON.stringify(state().highlighted),
      'submission changed scope',
    )
    assert(state().rootTerminals.length === roots, 'submission started an implementation agent')
    assert(
      (await smoke.planRead(opened.id)).text.includes('# Scoped TCP plan'),
      'plan was not saved',
    )
    for (const role of ['worker', 'denied', 'denied-named']) {
      const device = preset(
        role,
        role === 'denied' ? `-c 'features.network_proxy={domains={"127.0.0.1"="deny"}}'` : '',
      )
      const terminal = state().addRootTerminal(device)
      await smoke.startTerminal('@task', terminal)
      const sid = smoke.sessionId('@task', terminal, null)
      await until(`sandboxed ${role}`, () => text(sid).includes(`codex-network-finished ${role}`))
      if (role === 'worker') {
        assert(text(sid).includes('"passed": true'), 'configured validation did not pass')
        assert(text(sid).includes('unapproved-destination-blocked'), 'unapproved IP was accessible')
        assert(
          text(sid).includes('filesystem-restriction-preserved'),
          'filesystem permissions widened',
        )
      } else {
        assert(
          text(sid).replace(/\s+/g, '').includes('deniedthePatchbayloopbackdestination'),
          'explicit deny lost',
        )
      }
    }
    await smoke.report(
      'PASS codex-network: scoped SOCKS proposal, status, validation, explicit deny, blocked destination, preserved filesystem',
    )
  } catch (error) {
    const output = Object.keys(state().sessions)
      .map((sid) => `${sid}: ${text(sid)}`)
      .join('\n')
    await smoke.report(
      `FAIL codex-network: ${error?.message ?? error}; ${state().message}\n${output}`,
    )
  }
})()
