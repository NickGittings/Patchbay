// Graph actions smoke test, evaluated in the real desktop webview.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 20000
    for (;;) {
      const value = check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const change = (element, value) => {
    const prototype =
      element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
    element.dispatchEvent(
      new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    )
  }
  const button = (container, text) =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim() === text)
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  if (new URLSearchParams(location.search).has('component')) return
  try {
    const opened = await smoke.openProject()
    smoke.resetSessions(await smoke.terminalReset())
    const task = (id, command, readyWhen = '') => ({
      id,
      name: id,
      kind: 'task',
      command,
      readyWhen,
    })
    const component = (id, terminals, x) => ({
      id,
      name: id.toUpperCase(),
      path: '.',
      kind: 'service',
      notes: '',
      terminals,
      position: { x, y: 100 },
    })
    const project = {
      ...opened.project,
      components: [
        component('web', [task('dev', "printf 'web-start\\n'; cat"), task('check', 'exit 0')], 700),
        component(
          'api',
          [task('dev', "sleep 0.3; printf 'READY\\n'; cat", 'READY'), task('check', 'exit 3')],
          350,
        ),
        component('lib', [], 0),
      ],
      links: [
        { id: 'wa', source: 'web', target: 'api' },
        { id: 'al', source: 'api', target: 'lib' },
        { id: 'wl', source: 'web', target: 'lib' },
      ],
      groups: [],
    }
    state().loadProject(project)
    await until('hierarchy', () => document.querySelector('.component-groups'))
    for (const id of ['api', 'web']) {
      state().select(id)
      await until(
        `inspector for ${id}`,
        () => document.querySelector('.inspector input')?.value === id.toUpperCase(),
      )
      const rows = document.querySelectorAll('.inspector .terminal-row')
      for (const [index, role] of ['development', 'validation'].entries()) {
        const select = Array.from(rows[index].querySelectorAll('select')).find((el) =>
          Array.from(el.options).some((option) => option.value === 'development'),
        )
        assert(select, 'graph action selector missing')
        change(select, role)
      }
      await until(
        `${id} roles saved`,
        () => state().nodes.find((n) => n.id === id).data.terminals[1].action === 'validation',
      )
    }
    state().onNodesChange(
      ['web', 'api', 'lib'].map((id) => ({ type: 'select', id, selected: true })),
    )
    change(document.querySelector('[aria-label="New group name"]'), 'Smoke stack')
    await until(
      'group form enabled',
      () => !document.querySelector('.component-groups form button').disabled,
    )
    document
      .querySelector('.component-groups form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await until('group created', () => state().groups.length === 1)
    assert(state().groups[0].componentIds.length === 3, 'selected members missing')
    const groupId = state().groups[0].id
    const editor = document.querySelector('.component-group')
    editor.querySelector('summary').click()
    const ordered = Array.from(editor.querySelectorAll('label')).find((l) =>
      l.textContent.includes('Start dependencies first'),
    )
    ordered.querySelector('input').click()
    await until('ordering enabled', () => state().groups[0].orderedStartup)
    state().syncProject(JSON.parse(JSON.stringify(state().toProject())))
    assert(
      state().groups.length === 1 && state().nodes[0].data.terminals[0].action === 'development',
      'configuration lost on sync',
    )
    const plan = await smoke.graphActionPlan(state().toProject(), { kind: 'startGroup', groupId })
    assert(
      plan.stages.map((stage) => stage.join(',')).join(';') === 'lib;api;web',
      'incorrect startup order',
    )
    button(editor, 'Start').click()
    await until(
      'environment startup',
      () => !state().graphActionBusy && state().graphActionReport?.results.length === 2,
    )
    assert(
      state().sessions[smoke.sessionId('api', 'dev')]?.status?.ready,
      'API readiness was not observed',
    )
    assert(state().sessions[smoke.sessionId('web', 'dev')]?.running, 'web did not start')
    assert(
      state().sessions[smoke.sessionId('web', 'dev')].startedMs -
        state().sessions[smoke.sessionId('api', 'dev')].startedMs >=
        200,
      'consumer started before readiness',
    )
    assert(document.querySelector('.action-results'), 'results did not render')
    button(editor, 'Stop').click()
    await until(
      'environment stopped',
      () =>
        !state().sessions[smoke.sessionId('api', 'dev')]?.running &&
        !state().sessions[smoke.sessionId('web', 'dev')]?.running,
    )
    state().select('lib')
    await until(
      'library inspector',
      () => document.querySelector('.inspector input')?.value === 'LIB',
    )
    button(document.querySelector('.inspector'), 'Validate affected').click()
    await until(
      'validation results',
      () =>
        !state().graphActionBusy &&
        state().graphActionReport?.plan.request.kind === 'validateAffected',
    )
    const report = state().graphActionReport
    assert(
      report.results.map((r) => `${r.sessionId}:${r.outcome}`).join(',') ===
        `${smoke.sessionId('api', 'check')}:failed,${smoke.sessionId('web', 'check')}:passed`,
      'validation scope or outcomes incorrect',
    )
    assert(report.plan.skipped.join(',') === 'lib', 'unconfigured validator was not reported')
    await until('failed result rendered', () => document.querySelector('.action-result .failed'))
    Array.from(document.querySelectorAll('.action-result'))
      .find((el) => el.dataset.session === smoke.sessionId('web', 'check'))
      .click()
    await until(
      'result terminal selected',
      () =>
        state().activeSession === smoke.sessionId('web', 'check') && state().selectedId === 'web',
    )
    button(editor, 'Plan').click()
    await until(
      'group planner scope',
      () => state().view === 'plan' && state().highlighted.length === 3,
    )
    state().setView('navigation')
    state().onNodesChange([{ type: 'remove', id: 'lib' }])
    assert(!state().groups[0].componentIds.includes('lib'), 'removed member remained in group')
    await smoke.graphActionPlan(state().toProject(), { kind: 'startGroup', groupId })
    smoke.resetSessions(await smoke.terminalReset())
    // Reopening a closed project starts from its saved map.
    state().closeProject(project.projectId)
    state().loadProject(project)
    assert(
      state().groups.length === 0 && state().graphActionReport === null,
      'project reset retained graph action state',
    )
    await smoke.report(
      'PASS actions: task roles, saved groups, ordered startup, readiness, stop, affected validation, results, planner scope, removal, reset',
    )
  } catch (e) {
    await smoke.report(`FAIL actions: ${e?.message ?? e}`)
  }
})()
