// Stack detection by an agent: its proposal reaches the Stack panel and applies as map edits.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 30000
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  if (new URLSearchParams(location.search).has('component')) return
  const button = (root, text) =>
    Array.from(root?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent.trim().startsWith(text),
    )
  const edit = (el, value) => {
    assert(el, 'missing field')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const card = (name) =>
    [...document.querySelectorAll('.stack-card')].find(
      (c) => c.querySelector('strong')?.textContent === name,
    )
  const submitter = (proposal) => [
    {
      id: 'smoke-stacker',
      name: 'Smoke stacker',
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: `cat "$PATCHBAY_CONTEXT_FILE"; printf '%s' '${JSON.stringify(proposal)}' | "$PATCHBAY_CLI" agent propose-stack --file -; exec cat`,
    },
  ]
  try {
    const opened = await smoke.openProject()
    smoke.resetSessions(await smoke.terminalReset())
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
        component(
          'api',
          [
            { id: 'serve', name: 'Serve', kind: 'task', command: 'make api' },
            { id: 'shell', name: 'Shell', kind: 'shell', command: '' },
            { id: 'agent', name: 'Agent', kind: 'agent', command: 'cat' },
            { id: 'test', name: 'Test', kind: 'task', command: 'exit 0', action: 'validation' },
          ],
          0,
        ),
        component('web', [], 350),
      ],
      links: [{ id: 'wa', source: 'web', target: 'api' }],
      groups: [],
    }
    smoke.acceptOpened({ ...opened, project })
    await smoke.syncAgentProject(state().toProject())
    const stack = {
      version: 1,
      name: 'Local stack',
      orderedStartup: true,
      worktreeSetup: { command: 'printf preparation', reason: 'README.md:5 install dependencies' },
      terminals: [
        { component: 'api', terminal: 'serve', readyWhen: 'Listening on', reason: 'Makefile:3' },
        {
          component: 'web',
          name: 'Vite',
          command: 'npx vite',
          readyWhen: 'ready in',
          reason: 'web/vite.config.ts:1',
        },
      ],
    }
    state().setDevices([
      {
        id: 'smoke-stacker',
        name: 'Smoke stacker',
        category: 'agent',
        kind: 'agent',
        source: 'builtin',
        // Its token may propose a stack but run nothing.
        command:
          `"$PATCHBAY_CLI" agent environment start none 2>&1; echo "start-exit:$?"; ` +
          `printf '%s' '${JSON.stringify(stack)}' | "$PATCHBAY_CLI" agent propose-stack --file -; exec cat`,
      },
    ])
    smoke.selectPanel('stack')
    const panel = await until('stack panel', () => document.querySelector('.component-groups'))
    const setup = [...panel.querySelectorAll('summary')].find(
      (el) => el.textContent === 'Stack setup and suggestions',
    )
    setup.click()
    const detect = await until('detect button', () => button(panel, 'Detect stack with an agent'))
    detect.click()
    const sid = smoke.sessionId('@map', 'stack', null)
    await until('agent submission', () =>
      smoke.terminalText(sid).text.replace(/\s+/g, '').includes('"submitted":2'),
    )
    assert(
      /start-exit:[1-9]/.test(smoke.terminalText(sid).text),
      'stack detection was allowed to start an environment',
    )
    smoke.selectPanel('stack')
    const review = await until('proposed stack', () =>
      document.querySelector('[aria-label="Proposed stack"]'),
    )
    assert(review.textContent.includes('Makefile:3'), 'the reason must be shown')
    assert(review.textContent.includes('Vite (new)'), 'a new terminal must be marked new')
    assert(review.textContent.includes('README.md:5'), 'preparation evidence missing')
    assert(
      !document.querySelector('[aria-label="Preparation needs attention"]'),
      'unconfigured task shows a notice',
    )
    button(review, 'Apply').click()
    await until('stack applied', () => state().groups.length === 1)
    const [group] = state().groups
    assert(group.name === 'Local stack' && group.orderedStartup, 'stack settings lost')
    assert(group.componentIds.join(',') === 'api,web', `members ${group.componentIds}`)
    const api = state().nodes.find((n) => n.id === 'api').data.terminals[0]
    assert(api.action === 'development' && api.readyWhen === 'Listening on', 'api not marked')
    const web = state().nodes.find((n) => n.id === 'web').data.terminals[0]
    assert(
      web?.command === 'npx vite' && web.action === 'development' && web.kind === 'task',
      'new terminal not added',
    )
    await until('proposal cleared', () => !document.querySelector('[aria-label="Proposed stack"]'))
    await until(
      'proposal cleared on disk',
      async () => !(await smoke.stackProposalRead(state().project.id)),
    )
    assert(
      state().project.worktreeSetup.command === stack.worktreeSetup.command,
      'preparation not applied',
    )
    assert(await smoke.saveMap(state().project.id), 'map save failed')
    assert(await smoke.flushMapSaves(), 'map flush failed')
    assert(
      (await smoke.reloadProject(state().project.id)).project.worktreeSetup.command ===
        stack.worktreeSetup.command,
      'preparation not persisted',
    )
    assert(
      document.querySelector('[aria-label="Worktree preparation"]'),
      'preparation editor not in Stack',
    )
    assert(
      !Object.values(state().sessions).some((s) => s.command === stack.worktreeSetup.command),
      'applying ran preparation',
    )
    smoke.stopTerminal(sid)
    await until('detection stopped', () => !state().sessions[sid]?.running)
    // Redetect a renamed stack with one corrected command and fewer components.
    state().updateGroup(group.id, { name: 'Renamed stack' })
    const replacement = {
      version: 1,
      stackId: group.id,
      name: 'Repaired stack',
      orderedStartup: false,
      terminals: [
        {
          component: 'api',
          terminal: 'serve',
          command: 'printf corrected && exec cat',
          readyWhen: '',
          reason: 'README.md:9 corrected app launch',
        },
      ],
    }
    state().setDevices(submitter(replacement))
    button(await until('renamed card', () => card('Renamed stack')), 'Detect again').click()
    const replacementReview = await until('replacement review', () =>
      document.querySelector('[aria-label="Proposed stack"]'),
    )
    assert(
      replacementReview.textContent.includes('Removed components: WEB'),
      'member removal not reviewed',
    )
    assert(replacementReview.textContent.includes('WEB › Vite'), 'obsolete startup not reviewed')
    assert(
      replacementReview.textContent.includes('Replaces: make api'),
      'command correction not reviewed',
    )
    await until('target briefing', () => smoke.terminalText(sid).text.includes(`Replace stack`))
    const beforeCancel = JSON.stringify(state().toProject())
    button(replacementReview, 'Discard').click()
    await until('discarded', () => !document.querySelector('[aria-label="Proposed stack"]'))
    assert(JSON.stringify(state().toProject()) === beforeCancel, 'discard changed configuration')
    smoke.stopTerminal(sid)
    await until('detection stopped again', () => !state().sessions[sid]?.running)
    button(card('Renamed stack'), 'Detect again').click()
    const secondReview = await until('second replacement', () =>
      document.querySelector('[aria-label="Proposed stack"]'),
    )
    button(secondReview, 'Apply').click()
    await until('replacement applied', () => state().groups[0].name === 'Repaired stack')
    assert(
      state().groups.length === 1 && state().groups[0].id === group.id,
      'replacement duplicated stack',
    )
    assert(state().groups[0].componentIds.join(',') === 'api', 'obsolete member retained')
    assert(!state().groups[0].orderedStartup, 'ordering not replaced')
    const apiAfter = state().nodes.find((n) => n.id === 'api').data.terminals
    assert(
      apiAfter.length === 4 && apiAfter[0].command === replacement.terminals[0].command,
      'terminal duplicated or command not corrected',
    )
    assert(apiAfter[0].readyWhen === '', 'faulty readiness retained')
    assert(
      apiAfter[1].kind === 'shell' &&
        apiAfter[2].kind === 'agent' &&
        apiAfter[3].action === 'validation',
      'unrelated terminals changed',
    )
    const obsolete = state().nodes.find((n) => n.id === 'web').data.terminals[0]
    assert(
      obsolete.id === web.id && !obsolete.action && obsolete.command === 'npx vite',
      'obsolete definition deleted or still starts',
    )
    smoke.stopTerminal(sid)
    await until('detection finished', () => !state().sessions[sid]?.running)

    // Configure a runnable stack using only the rail controls.
    state().onNodesChange(state().nodes.map((n) => ({ id: n.id, type: 'select', selected: false })))
    state().select(null)
    button(panel, '＋ New stack').click()
    edit(
      await until('new stack form', () => panel.querySelector('[aria-label="New stack name"]')),
      'Manual stack',
    )
    await until('new stack enabled', () => !panel.querySelector('form button').disabled)
    panel
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const manual = await until('manual card', () => card('Manual stack'))
    const member = [...manual.querySelectorAll('.group-members label')].find(
      (l) => l.textContent.trim() === 'API',
    )
    member.querySelector('input').click()
    const terminalEditor = await until('rail terminal editor', () =>
      manual.querySelector('[aria-label="API Development terminals"]'),
    )
    terminalEditor.querySelector('input[type="checkbox"]').click() // Keep Serve saved, outside startup.
    button(terminalEditor, 'Add Development terminal').click()
    const custom = await until('custom terminal', () =>
      state()
        .nodes.find((n) => n.id === 'api')
        .data.terminals.find((t) => t.name === 'Development'),
    )
    const command = `printf 'prepared:%s\\n' "$PWD" && printf 'build-ok\\n' && printf 'APP_READY:%s\\n' "$PWD" && exec cat`
    edit(manual.querySelector(`[aria-label="API › ${custom.id} name"]`), 'App')
    edit(manual.querySelector(`[aria-label="API › ${custom.id} command"]`), command)
    edit(manual.querySelector(`[aria-label="API › ${custom.id} ready when"]`), 'APP_READY:')
    await until('manual command saved', () =>
      state()
        .nodes.find((n) => n.id === 'api')
        .data.terminals.some((t) => t.command === command),
    )
    const manualGroup = state().groups.find((g) => g.name === 'Manual stack')
    assert(await smoke.saveMap(state().project.id), 'manual map save failed')
    assert(await smoke.flushMapSaves(), 'manual map flush failed')
    const persisted = (await smoke.reloadProject(state().project.id)).project
    assert(
      persisted.groups.some((g) => g.id === manualGroup.id),
      'manual stack not persisted',
    )
    assert(
      persisted.components
        .find((c) => c.id === 'api')
        .terminals.some((t) => t.id === custom.id && t.command === command),
      'manual terminal not persisted',
    )
    // Preparation configured earlier stays optional; the Development command prepares at Start.
    smoke.store.setState({ project: { ...state().project, worktreeSetup: undefined }, dirty: true })
    const task = await smoke.createTask({
      title: 'Stack checkout',
      branch: 'smoke/stack-checkout',
      components: ['api'],
    })
    smoke.selectPanel('stack')
    button(await until('manual card in task', () => card('Manual stack')), 'Start').click()
    const taskSid = smoke.sessionId('api', custom.id, task.id)
    await until(
      'fresh worktree app ready',
      () => !state().graphActionBusy && state().sessions[taskSid]?.status?.ready,
    )
    await until('fresh worktree launch output', async () => {
      const snapshot = await smoke.terminalSnapshot(taskSid)
      return (
        snapshot?.launchDirectory === task.worktree &&
        atob(snapshot.data).includes(`APP_READY:${task.worktree}`)
      )
    })
    const startedMs = state().sessions[taskSid].startedMs
    button(card('Manual stack'), 'Start').click()
    await until(
      'repeated Start reused',
      () => !state().graphActionBusy && state().graphActionReport?.results[0]?.outcome === 'reused',
    )
    assert(state().sessions[taskSid].startedMs === startedMs, 'repeated Start duplicated launch')
    state().setActiveTask(null)
    button(await until('main card', () => card('Manual stack')), 'Start').click()
    const mainSid = smoke.sessionId('api', custom.id, null)
    await until(
      'main worktree app ready',
      () => !state().graphActionBusy && state().sessions[mainSid]?.status?.ready,
    )
    await until('main checkout launch output', async () => {
      const snapshot = await smoke.terminalSnapshot(mainSid)
      return (
        snapshot?.launchDirectory === state().project.root &&
        atob(snapshot.data).includes(`APP_READY:${state().project.root}`)
      )
    })
    assert(state().sessions[taskSid]?.running, 'switching checkouts stopped the other app')
    // Both stacks use the same shared terminal definition and release ownership independently.
    button(card('Repaired stack'), 'Start').click()
    await until(
      'shared terminal reused',
      () => !state().graphActionBusy && state().graphActionReport?.results[0]?.outcome === 'reused',
    )
    button(card('Manual stack'), 'Stop').click()
    await until('manual stop reported', () => state().message === 'Stack stopped')
    assert(state().sessions[mainSid]?.running, 'shared terminal stopped with another owner')
    button(card('Repaired stack'), 'Stop').click()
    await until('last owner stopped', () => !state().sessions[mainSid]?.running)
    assert(state().sessions[taskSid]?.running, 'main Stop stopped task worktree')
    state().setActiveTask(task.id)
    button(await until('task card', () => card('Manual stack')), 'Stop').click()
    await until('task stopped', () => !state().sessions[taskSid]?.running)
    state().setActiveTask(null)
    // A failed build must prevent app launch.
    const mainCard = await until('main manual card', () => card('Manual stack'))
    mainCard.querySelector('details').open = true
    edit(
      mainCard.querySelector(`[aria-label="API › ${custom.id} command"]`),
      'false && printf SHOULD_NOT_LAUNCH && exec cat',
    )
    await until('failed command saved', () =>
      state()
        .nodes.find((n) => n.id === 'api')
        .data.terminals.find((t) => t.id === custom.id)
        .command.startsWith('false'),
    )
    button(mainCard, 'Start').click()
    await until(
      'failed build reported',
      () => !state().graphActionBusy && /exited before|failed/i.test(state().message ?? ''),
    )
    assert(!state().sessions[mainSid]?.running, 'failed build launched app')
    await smoke.removeTask(task.id, true)
    await smoke.report(
      'PASS stack: detection, cancellation, replacement, manual configuration, persistence, worktree launch, repeated Start, shared terminals, Stop, failed build',
    )
  } catch (e) {
    await smoke.report(`FAIL stack: ${e?.message ?? e} ${e?.stack ?? ''}`)
  }
})()
