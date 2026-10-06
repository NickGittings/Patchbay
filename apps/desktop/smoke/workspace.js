// Run with two backend-configured fixtures and an isolated PATCHBAY_STATE_DIR.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const s = () => smoke.store.getState()
  try {
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    const first = s().nodes[0]
    s().updateComponent(first.id, {
      terminals: [
        {
          id: 'counter',
          name: 'Counter',
          kind: 'task',
          command: 'echo process:$$; i=0; while :; do echo number:$i; i=$((i+1)); sleep 0.1; done',
        },
      ],
    })
    s().select(first.id)
    s().setView('plan')
    s().toggleHighlight(first.id)
    await smoke.startTerminal(first.id, 'counter')
    const sidOne = smoke.sessionId(first.id, 'counter')
    await until('first counter', () => s().sessions[sidOne]?.running)
    await smoke.openComponentWindow(first.id, first.data.name)
    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    // Identical component/terminal identifiers must remain isolated.
    const project = s().toProject()
    s().syncProject({
      ...project,
      components: [
        {
          ...one.project.components[0],
          id: first.id,
          path: '.',
          terminals: [
            { id: 'counter', name: 'Counter', kind: 'task', command: 'echo second-only; sleep 30' },
          ],
        },
      ],
      links: [],
    })
    s().select(first.id)
    await smoke.startTerminal(first.id, 'counter')
    const sidTwo = smoke.sessionId(first.id, 'counter')
    if (sidOne === sidTwo) throw new Error('Project session IDs collided')
    await until('second counter', () => s().sessions[sidTwo]?.running)
    if (!s().sessions[sidOne]?.running) throw new Error('Switching stopped the first project')
    s().activateProject(one.id)
    if (s().view !== 'plan' || !s().highlighted.includes(first.id))
      throw new Error('Project layout/scope was lost')
    await until('continued output', () => smoke.terminalText(sidOne).text.includes('number:3'))
    s().activateProject(two.id)
    if (s().view !== 'navigation' || s().highlighted.length)
      throw new Error('Layouts leaked across projects')
    s().closeProject(one.id)
    await smoke.reconcileSessions()
    if (!s().sessionRecords.some((r) => r.id === sidOne && r.snapshot.running))
      throw new Error('Detached work is absent from Sessions')
    await smoke.report(
      'PASS workspace: two project identities, live pop-out, tab switches, independent planner/layout, detached session discovery',
    )
  } catch (e) {
    await smoke.report(`FAIL workspace: ${e.message ?? e}`)
  }
})()
