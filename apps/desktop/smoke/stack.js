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
  const detection = () => {
    const summary = [...document.querySelectorAll('.component-groups summary')].find(
      (el) => el.textContent === 'Stack Detection',
    )
    assert(summary, 'missing Stack Detection section')
    summary.parentElement.open = true
    return summary.parentElement
  }
  const selectTarget = async (id) => {
    const select = detection().querySelector('[aria-label="Stack detection target"]')
    assert(!select.disabled, 'target selection locked')
    select.value = id
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await until('target selected', () => select.value === id)
  }
  const assertDetectionLocked = () => {
    const controls = detection()
    assert(
      controls.querySelector('[aria-label="Stack detection target"]').disabled,
      'target unlocked',
    )
    assert(
      controls.querySelector('[aria-label="Stack detection agent"]').disabled,
      'agent unlocked',
    )
  }
  const checkRailLayout = async () => {
    const resize = document.querySelector('[aria-label="Resize utility panel"]')
    const original = Number(resize.getAttribute('aria-valuenow'))
    const setWidth = async (width) => {
      while (Number(resize.getAttribute('aria-valuenow')) !== width) {
        const current = Number(resize.getAttribute('aria-valuenow'))
        resize.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: current > width ? 'ArrowLeft' : 'ArrowRight',
            bubbles: true,
          }),
        )
        await until('rail resized', () => Number(resize.getAttribute('aria-valuenow')) !== current)
      }
    }
    for (const width of [240, 480]) {
      await setWidth(width)
      const scroll = document.querySelector('.utility-panel[data-panel="stack"] .utility-scroll')
      const overflow = [...scroll.querySelectorAll('*')]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .slice(0, 8)
        .map(
          (el) =>
            `${el.tagName}.${el.className}: ${el.clientWidth}/${el.scrollWidth}/${el.getBoundingClientRect().width}`,
        )
      assert(
        scroll.scrollWidth <= scroll.clientWidth + 1,
        `rail overflows at ${width}px (${scroll.scrollWidth}/${scroll.clientWidth}): ${overflow.join(', ')}`,
      )
      for (const el of scroll.querySelectorAll(
        '.stack-agent, .stack-card, .stack-suggestions, .worktree-setup-editor',
      )) {
        if (el.clientWidth)
          assert(el.scrollWidth <= el.clientWidth + 1, `${el.className} overflows at ${width}px`)
      }
      const controls = detection().querySelector('.stack-agent')
      const [target, agent] = controls.querySelectorAll('select')
      assert(
        Math.abs(target.getBoundingClientRect().width - controls.clientWidth) <= 1,
        'target is not full width',
      )
      assert(
        agent.getBoundingClientRect().top > target.getBoundingClientRect().bottom,
        'agent is not below target',
      )
    }
    await setWidth(Math.round(original / 20) * 20)
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
      worktreeSetup: {
        command:
          'printf preparation && npm --prefix packages/application-with-a-long-directory-name ci',
        reason: 'README.md:5 install dependencies',
      },
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
    assert(panel.textContent.includes('Stack Detection'), 'empty state uses the old section name')
    assert(
      detection().querySelector('[aria-label="Stack detection target"]').value === '',
      'detection should default to New stack',
    )
    // Removing a selected stack falls back to New stack.
    state().addGroup('Temporary target', ['api'])
    const temporary = state().groups.find((g) => g.name === 'Temporary target')
    await until('temporary target option', () =>
      detection().querySelector(`option[value="${temporary.id}"]`),
    )
    await selectTarget(temporary.id)
    const longName =
      'Development stack for application services and background workers with a very-long-unbroken-component-name-that-needs-to-wrap'
    state().updateGroup(temporary.id, { name: longName })
    await until('long stack name', () => card(longName))
    await checkRailLayout()
    state().removeGroup(temporary.id)
    await until(
      'deleted target reset',
      () => detection().querySelector('[aria-label="Stack detection target"]').value === '',
    )
    const detect = await until('detect button', () => button(detection(), 'Detect stack'))
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
    assert(review.closest('details').open, 'waiting proposal is hidden')
    assertDetectionLocked()
    const show = button(detection(), 'Show stack detection')
    assert(show && !show.disabled, 'running agent navigation locked by proposal')
    show.click()
    await until('running detection selected', () => state().activeSession === sid)
    assert(review.textContent.includes('Makefile:3'), 'the reason must be shown')
    assert(review.textContent.includes('Vite (new)'), 'a new terminal must be marked new')
    assert(review.textContent.includes('README.md:5'), 'preparation evidence missing')
    await checkRailLayout()
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
    const preparation = document.querySelector('[aria-label="Worktree preparation"]')
    preparation.closest('details').open = true
    assert(!preparation.querySelector('strong, pre'), 'preparation repeats its heading or command')
    await checkRailLayout()
    button(preparation, 'Save').click()
    await until('preparation save feedback', () =>
      preparation.textContent.includes('Preparation saved'),
    )
    button(preparation, 'Enable exact command locally').click()
    await until('preparation enablement feedback', () =>
      preparation.textContent.includes('Enabled locally'),
    )
    assert(
      !Object.values(state().sessions).some((s) => s.command === stack.worktreeSetup.command),
      'applying ran preparation',
    )
    smoke.stopTerminal(sid)
    await until('detection stopped', () => !state().sessions[sid]?.running)
    // Redetect a renamed stack with one corrected command and fewer components.
    await selectTarget(group.id)
    state().updateGroup(group.id, { name: 'Renamed stack' })
    await until(
      'renamed detection target',
      () =>
        detection().querySelector(`option[value="${group.id}"]`)?.textContent === 'Renamed stack',
    )
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
    assert(!card('Renamed stack').querySelector('.stack-agent'), 'saved card repeats detection')
    button(detection(), 'Detect stack').click()
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
    smoke.stopTerminal(sid)
    await until('proposal agent stopped', () => !state().sessions[sid]?.running)
    assertDetectionLocked()
    assert(button(detection(), 'Detect stack').disabled, 'pending proposal allows another run')
    const beforeCancel = JSON.stringify(state().toProject())
    button(replacementReview, 'Discard').click()
    await until('discarded', () => !document.querySelector('[aria-label="Proposed stack"]'))
    assert(JSON.stringify(state().toProject()) === beforeCancel, 'discard changed configuration')
    smoke.stopTerminal(sid)
    await until('detection stopped again', () => !state().sessions[sid]?.running)
    await until('detection unlocked', () => !button(detection(), 'Detect stack').disabled)
    button(detection(), 'Detect stack').click()
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

    // A proposal for a removed target stays reviewable but cannot be applied.
    state().addGroup('Removed during review', ['api'])
    const removed = state().groups.find((g) => g.name === 'Removed during review')
    await until('removable target option', () =>
      detection().querySelector(`option[value="${removed.id}"]`),
    )
    await selectTarget(removed.id)
    // Agent submissions validate the target against the saved map.
    assert(await smoke.saveMap(state().project.id), 'removed-target map save failed')
    assert(await smoke.flushMapSaves(), 'removed-target map flush failed')
    const removedDevices = submitter({ ...replacement, stackId: removed.id })
    removedDevices[0].id = 'smoke-removed-target'
    state().setDevices(removedDevices)
    await until(
      'new proposal agent preset',
      () =>
        detection().querySelector('[aria-label="Stack detection agent"]').value ===
        'smoke-removed-target',
    )
    button(detection(), 'Detect stack').click()
    const removedReview = await until('removed target review', () =>
      document.querySelector('[aria-label="Proposed stack"]'),
    )
    state().removeGroup(removed.id)
    await until('removed target apply locked', () => button(removedReview, 'Apply').disabled)
    assert(
      removedReview.textContent.includes('target stack was removed'),
      'missing removed target explanation',
    )
    assert(
      detection().querySelector('[aria-label="Stack detection target"]').value === '',
      'removed review target not reset',
    )
    button(removedReview, 'Discard').click()
    await until(
      'removed proposal discarded',
      () => !document.querySelector('[aria-label="Proposed stack"]'),
    )
    smoke.stopTerminal(sid)
    await until('removed proposal agent stopped', () => !state().sessions[sid]?.running)

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
    await until('successful action summary', () =>
      panel.querySelector('.stack-action-result')?.textContent.includes('1/1 tasks passed'),
    )
    assert(!panel.querySelector('.action-results'), 'successful action has an empty disclosure')
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
    const lastReport = state().graphActionReport
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
    // Startup errors may reject before returning a report. Exercise unsuccessful report
    // feedback with that terminal, keeping terminal navigation real.
    smoke.store.setState({
      graphActionReport: {
        ...lastReport,
        results: [{ sessionId: mainSid, outcome: 'failed', exitCode: 1 }],
      },
    })
    const feedback = await until('failed action details', () =>
      panel.querySelector('.action-results'),
    )
    feedback.open = true
    button(feedback, 'API').click()
    await until('failed terminal navigation', () => state().activeSession === mainSid)

    // Empty and skipped-only reports must not offer empty disclosures.
    const latest = state().graphActionReport
    smoke.store.setState({
      graphActionReport: { ...latest, results: [], plan: { ...latest.plan, skipped: [] } },
    })
    await until('empty action summary', () =>
      panel.querySelector('.stack-action-result')?.textContent.includes('No tasks ran'),
    )
    assert(!panel.querySelector('.action-results'), 'empty report has an empty disclosure')
    smoke.store.setState({
      graphActionReport: { ...latest, results: [], plan: { ...latest.plan, skipped: ['web'] } },
    })
    const skipped = await until('skipped-only details', () =>
      panel.querySelector('.action-results'),
    )
    assert(skipped.textContent.includes('WEB: no configured tasks'), 'skipped component missing')
    smoke.store.setState({ graphActionReport: latest })
    await smoke.removeTask(task.id, true)
    await smoke.report(
      'PASS stack: centralized detection, renamed/deleted targets, review locks, apply/discard, rail widths, preparation, action feedback, terminal navigation, manual configuration, persistence, worktree launch, repeated Start, shared terminals, Stop, failed build',
    )
  } catch (e) {
    const sid = smoke.sessionId('@map', 'stack', null)
    await smoke.report(
      `FAIL stack: ${e?.message ?? e} ${e?.stack ?? ''}\n${state().message ?? ''}\n${smoke.terminalText(sid).text.slice(-1500)}`,
    )
  }
})()
