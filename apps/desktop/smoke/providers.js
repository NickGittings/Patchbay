;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check) => {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const smoke = await until('smoke', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    await until('connected', () => state().serviceConnected && !state().restoring)
    const fixture = opened.project.root.replace(/\/project$/, '/provider.py')
    const preset = (id, role = id) => ({
      id,
      name: id,
      command: `python3 '${fixture}' '${role}'`,
      kind: 'agent',
      source: 'user',
      category: 'agent',
    })
    const devices = [
      'scan-a',
      'scan-b',
      'planner',
      'coordinator',
      'worker-a',
      'worker-b',
      'review',
    ].map((id) => preset(id))
    state().setDevices(devices)
    state().setAgentRoles({
      scan: ['scan-a', 'scan-b'],
      plan: ['planner'],
      implement: ['coordinator'],
      worker: ['worker-a', 'worker-b'],
    })
    const task = await smoke.taskCreate(
      { title: 'Providers', branch: 'providers-feature', components: ['app'] },
      opened.id,
    )
    await smoke.refreshTasks(opened.id)
    state().setActiveTask(task.id)
    state().patchTask(opened.id, task.id, { highlighted: ['app'] })
    const project = state().toProject()
    const scans = await smoke.createProviderRun(
      project,
      'scan',
      'Add isolated files',
      ['app'],
      task.id,
      devices.slice(0, 2),
    )
    const completed = await until('two explicit reports', async () => {
      const r = (await smoke.driveProviderRuns(opened.id)).find((r) => r.id === scans.id)
      return r?.state === 'complete' && r
    })
    assert(
      completed.jobs.every((j) => j.report),
      'A scanner completed without an explicit report',
    )
    await smoke.startTerminal('@plan', 'planner', task.id, opened.id, {
      kickoff: { kind: 'plan' },
      scanRound: scans.id,
      auto: {
        goal: 'Add isolated files',
        fixFloor: null,
        effortNote: 'Plan from findings',
        commit: false,
      },
    })
    await until('one planner received both reports', async () =>
      (await smoke.planRead(opened.id)).text.includes('Provider plan'),
    )
    const build = await smoke.implementPlannerPlan('planner')
    assert(build.implementationRun, 'Workers did not select a coordinator')
    const integrated = await until('isolated workers integrated', async () => {
      const r = (await smoke.driveProviderRuns(opened.id)).find(
        (r) => r.id === build.implementationRun,
      )
      if (r?.state === 'paused') throw new Error(r.error)
      return r?.state === 'complete' && r
    })
    assert(
      integrated.jobs.length === 2 && integrated.jobs.every((j) => j.state === 'integrated'),
      'Integration barrier was bypassed',
    )
    assert(integrated.jobs[0].task !== integrated.jobs[1].task, 'Workers shared a worktree')
    const validation = await smoke.graphActionIn(opened.id, task.id, project, {
      kind: 'validateChanged',
      componentIds: ['app'],
    })
    assert(
      validation.results.length === 1 && validation.results[0].outcome === 'passed',
      'Validation ran before worker files were integrated',
    )
    await smoke.startReviewAgents(
      project,
      { worktree: task.worktree, branch: 'providers-feature', base: 'main' },
      [devices.at(-1)],
    )
    await until(
      'review after integration',
      async () => (await smoke.reviewRead(opened.id, 'providers-feature'))?.verdict?.clean,
    )
    state().setView('implementation')
    await until('assignments in Build', () =>
      document.querySelector('[aria-label="Implementation assignments"] table'),
    )
    await smoke.report(
      'PASS providers: two scans reached one planner; isolated workers integrated before validation and review',
    )
  } catch (e) {
    await smoke.report(`FAIL providers: ${e.message ?? e} ${e.stack ?? ''}`)
  }
})()
