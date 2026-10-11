// The app and terminals remain usable when the agent endpoint cannot be written.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const result = check()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    smoke.acceptOpened(await smoke.openProject())
    const terminalId = state().addRootTerminal({
      id: 'bridge-probe',
      name: 'Bridge probe',
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: 'printf "app-open-without-bridge\\n"; exec cat',
    })
    const sid = smoke.sessionId('@task', terminalId)
    await smoke.startTerminal('@task', terminalId)
    await until('agent process without bridge', () =>
      smoke.terminalText(sid).text.includes('app-open-without-bridge'),
    )
    if (!state().sessions[sid]?.notice?.includes("the desktop bridge didn't start"))
      throw new Error('Missing agent-command notice')
    await smoke.report(
      'PASS bridge: startup failure keeps app and agent terminals usable with notice',
    )
  } catch (error) {
    await smoke.report(`FAIL bridge: ${error?.message ?? error}`)
  }
})()
