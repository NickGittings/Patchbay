// Task smoke test, run against the scratch repo smoke/tasks-fixture.sh creates: a task gets its
// own branch and worktree, the same terminal runs in the open worktree and the task's at once,
// Git badges, review and attention follow the active task, and a dirty worktree isn't removed.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const click = (el) => {
    if (!el) throw new Error('missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const edit = (el, value) => {
    if (!el) throw new Error('missing input target')
    const prototype =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const button = (root, name) =>
    Array.from(root?.querySelectorAll('button') ?? []).find((b) => b.textContent.trim() === name)
  const openPicker = async () => {
    smoke.selectPanel('worktree')
    return until(`worktree overview in ${state().view}`, () =>
      document.querySelector('[aria-label="Worktree panel"] .utility-scroll'),
    )
  }
  const viewButton = (name) =>
    Array.from(document.querySelectorAll('.workspace-rail > button')).find(
      (b) => b.getAttribute('aria-label') === name,
    )
  // Without whitespace, since long paths wrap across terminal rows.
  const textOf = (sid) => smoke.terminalText(sid).text.replace(/\s+/g, '')
  let task
  let secondTask
  try {
    const opened = await smoke.openProject()
    if (!opened) throw new Error('project was not opened')
    state().loadProject({
      ...opened.project,
      components: [
        {
          id: 'web',
          name: 'Web',
          kind: 'frontend',
          path: 'apps/web',
          notes: '',
          position: { x: 0, y: 0 },
          terminals: [
            {
              id: 'where',
              name: 'Where',
              command: 'printf "cwd:%s\\n" "$PWD"; exec cat',
              kind: 'task',
            },
            { id: 'shell', name: 'Shell', command: '', kind: 'shell' },
          ],
        },
        {
          id: 'docs',
          name: 'Docs',
          kind: 'library',
          path: '.',
          notes: '',
          position: { x: 300, y: 0 },
          terminals: [],
        },
      ],
      links: [],
    })
    await smoke.syncCurrentRoots()
    await smoke.refreshTasks()
    assert(state().tasks.length === 0, 'a fresh repo has tasks')

    const setupCommand =
      'printf "setup:%s:%s:%s\\n" "$PWD" "$PATCHBAY_PROJECT_ROOT" "$PATCHBAY_WORKTREE_ROOT"'
    smoke.store.setState({
      project: { ...state().project, worktreeSetup: { command: setupCommand } },
      dirty: true,
    })
    await smoke.saveProject(state().toProject(), null)
    await smoke.enableWorktreeSetup(state().project.id, setupCommand)

    // Start work from Plan, carrying both highlighted components into the dialog.
    click(viewButton('Plan'))
    state().toggleHighlight('web')
    state().toggleHighlight('docs')
    click(
      await until('New worktree', () =>
        button(document.querySelector('.plan-scope'), '＋ New task'),
      ),
    )
    const dialog = await until('New worktree dialog', () =>
      document.querySelector('[aria-label="New task"]'),
    )
    assert(
      dialog.querySelectorAll('.chip.active').length === 2,
      'worktree lost highlighted components',
    )
    assert(dialog.textContent.includes('Goal title'), 'worktree purpose label missing')
    edit(dialog.querySelector('input'), 'Smoke task')
    await until(
      'branch from purpose',
      () => dialog.querySelectorAll('input')[1].value === 'smoke-task',
    )
    edit(dialog.querySelectorAll('input')[1], 'smoke/task')
    click(
      await until('Create worktree button', () => {
        const create = button(dialog, 'Create task')
        return create && !create.disabled && create
      }),
    )
    task = await until('created worktree', () =>
      state().tasks.find((t) => t.branch === 'smoke/task'),
    )
    await until('creation dialog closed', () => !document.querySelector('.task-dialog'))
    const prepared = await until('worktree setup ready', async () => {
      const setup = await smoke.worktreeSetup(state().project.id, task.id)
      if (!setup) throw new Error('Setup configuration was not captured')
      return setup?.status === 'ready' && setup
    })
    assert(prepared.attempt === 1, 'setup ran more than once')
    await smoke.worktreeSetup(state().project.id, task.id, 'stop')
    const notice = await until('preparation attention notice', () =>
      document.querySelector('[aria-label="Preparation needs attention"]'),
    )
    button(notice, 'Open Stack').click()
    const taskPreparation = await until('task preparation in Stack', () =>
      document.querySelector('.component-groups [aria-label="Task preparation"]'),
    )
    assert(taskPreparation.textContent.includes('Stopped'), 'stopped status missing in Stack')
    button(taskPreparation, 'Continue without setup').click()
    await until(
      'preparation notice cleared',
      () => !document.querySelector('[aria-label="Preparation needs attention"]'),
    )

    const setupSnapshot = await smoke.terminalSnapshot(prepared.session)
    const setupText = atob(setupSnapshot.data)
    assert(
      setupText.includes(`setup:${task.worktree}:${state().project.root}:${task.worktree}`),
      'setup ran with incorrect directories',
    )

    assert(task.components.length === 2, 'worktree scope was not saved')
    assert(task.branch === 'smoke/task' && !task.missing, 'task has no branch')
    assert(/patchbay-smoke-tasks\/shop-smoke-task$/.test(task.worktree), task.worktree)
    assert(state().activeTask === task.id, 'a new task is not active')
    click(viewButton('Plan'))
    await until('worktree in the Plan picker', () =>
      document
        .querySelector('.workspace-rail [aria-label="Worktree"]')
        ?.title.includes('Smoke task'),
    )

    await until('highlighted task membership', () =>
      document.querySelector('.component-node.in-task.highlighted .task-badge'),
    )

    // The same terminal, in both worktrees at once.
    const mainSid = smoke.sessionId('web', 'where', null)
    const taskSid = smoke.sessionId('web', 'where', task.id)
    await smoke.startTerminal('web', 'where', null)
    await smoke.startTerminal('web', 'where', task.id)
    await until('main cwd', () => textOf(mainSid).includes('cwd:'))
    await until('task cwd', () => textOf(taskSid).includes('cwd:'))
    assert(
      /cwd:\S*patchbay-smoke-tasks\/shop\/apps\/web/.test(textOf(mainSid)),
      `main terminal ran in ${textOf(mainSid)}`,
    )
    assert(
      /cwd:\S*shop-smoke-task\/apps\/web/.test(textOf(taskSid)),
      `task terminal ran in ${textOf(taskSid)}`,
    )
    assert(state().sessions[mainSid]?.running && state().sessions[taskSid]?.running, 'not both')

    // An edit in the task's worktree shows on the map only while the task is active.
    const shellSid = smoke.sessionId('web', 'shell', task.id)
    await smoke.startTerminal('web', 'shell', task.id)
    await until('task shell', () => state().sessions[shellSid]?.running)
    await sleep(1500)
    await smoke.terminalWrite(shellSid, 'printf x > smoke.txt\r')
    await smoke.requestGitRefresh()
    await until('task change badge', async () => {
      await smoke.requestGitRefresh()
      return state().gitChanges.web === 1
    })
    state().setActiveTask(null)
    await until('open worktree badge', async () => {
      await smoke.requestGitRefresh()
      return state().gitChanges.web === 0
    })
    state().setActiveTask(task.id)

    // Review follows the active task, with its task terminals' status.
    click(viewButton('Review'))
    await until('task review', () =>
      document.querySelector('.review-banner')?.textContent.includes('Smoke task'),
    )
    await until('task validation', () =>
      document.querySelector('.review-view .validation-chip.running'),
    )

    // Navigation's Worktree panel returns to the main worktree; switching never stops sessions.
    click(viewButton('Navigation'))
    const navOverview = await openPicker()
    const taskRow = await until('Navigation task row', () =>
      navOverview.querySelector('.worktree-row.active'),
    )
    // Even the selected card's background invokes selection; the dock stays open.
    const setActiveTask = state().setActiveTask
    let selectedAgain = false
    smoke.store.setState({
      setActiveTask: (id, exact) => {
        selectedAgain = id === task.id
        setActiveTask(id, exact)
      },
    })
    try {
      click(taskRow)
      await sleep(100)
      assert(selectedAgain, 'selected worktree background did not invoke selection')
    } finally {
      smoke.store.setState({ setActiveTask })
    }
    assert(
      state().activeTask === task.id && document.querySelector('[aria-label="Worktree panel"]'),
      'clicking the active worktree card switched or closed the picker',
    )
    // Clicking the card outside its controls switches.
    click(navOverview.querySelector('.worktree-row:not(.active)'))
    await until(
      'main worktree active',
      () => state().activeTask === null && document.querySelector('[aria-label="Worktree panel"]'),
    )
    click(viewButton('Plan'))
    const overview = await openPicker()
    const projectRow = await until('Main worktree branch', () => {
      const row = overview.querySelector('.worktree-row.active')
      return row?.textContent.includes('main') && row
    })
    assert(projectRow.textContent.includes('Main worktree'), 'main worktree label missing')
    // Another card's own controls and its path (kept for copying) don't switch.
    const otherRow = overview.querySelector('.worktree-row:not(.active)')
    assert(otherRow.querySelector('.worktree-row-switch').title, 'Missing worktree path tooltip')
    assert(
      [...otherRow.querySelectorAll('.worktree-signal')].every(
        (b) => b.getAttribute('aria-expanded') === 'false' && b.title,
      ),
      'Worktree details must start collapsed with tooltips',
    )
    const signal = (row, label) => row.querySelector(`.worktree-signal[aria-label^="${label}:"]`)
    for (const label of ['Tests', 'Issues', 'Changes', 'Running']) {
      const toggle = signal(otherRow, label)
      toggle.focus()
      assert(document.activeElement === toggle, `${label} toggle cannot receive keyboard focus`)
      click(toggle)
      await until(`${label} expanded`, () => toggle.getAttribute('aria-expanded') === 'true')
      assert(
        state().activeTask === null && state().utilityPanel === 'worktree',
        `${label} toggle selected the worktree or closed the panel`,
      )
      assert(
        !otherRow.querySelector(`[role="region"][aria-label="${label}"]`).hidden,
        `${label} details are hidden`,
      )
    }
    click(signal(otherRow, 'Tests'))
    await sleep(50)
    assert(
      signal(otherRow, 'Tests').getAttribute('aria-expanded') === 'false' &&
        signal(otherRow, 'Running').getAttribute('aria-expanded') === 'true',
      'Closing one category collapsed another',
    )
    click(otherRow.querySelector('[role="region"][aria-label="Running"]'))
    assert(state().activeTask === null, 'Detail background selected the worktree')
    // Selecting text on another card must keep it available to copy.
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(otherRow.querySelector('strong'))
    selection.removeAllRanges()
    selection.addRange(range)
    click(otherRow)
    assert(state().activeTask === null, 'Text selection switched worktrees')
    selection.removeAllRanges()
    // The compact layout must also fit a narrow dock with long names and branches.
    const panel = document.querySelector('[aria-label="Worktree panel"]')
    const originalWidth = panel.style.width
    const title = otherRow.querySelector('strong')
    const branch = otherRow.querySelector('.worktree-row-switch code')
    const originalTitle = title.textContent
    const originalBranch = branch.textContent
    try {
      panel.style.width = '240px'
      title.textContent = 'A very long worktree name '.repeat(12)
      branch.textContent = 'feature/a-very-long-branch-name/'.repeat(12)
      await sleep(50)
      const scroll = panel.querySelector('.utility-scroll')
      assert(scroll.scrollWidth <= scroll.clientWidth + 1, 'Compact worktree card overflows')
      assert(title.scrollWidth > title.clientWidth, 'Long worktree name is not truncated')
      assert(
        branch.scrollWidth > branch.clientWidth,
        `Long branch is not truncated: ${JSON.stringify({
          scroll: branch.scrollWidth,
          client: branch.clientWidth,
          width: branch.getBoundingClientRect().width,
          text: branch.textContent,
          display: getComputedStyle(branch).display,
        })}`,
      )
    } finally {
      panel.style.width = originalWidth
      title.textContent = originalTitle
      branch.textContent = originalBranch
    }
    // Missing worktrees keep their management controls but cannot be selected or expanded.
    const originalTasks = state().tasks
    try {
      smoke.store.setState({
        tasks: originalTasks.map((t) => (t.id === task.id ? { ...t, missing: true } : t)),
      })
      await until('missing worktree card', () => otherRow.classList.contains('missing'))
      click(otherRow)
      assert(state().activeTask === null, 'Missing worktree selected')
      assert(otherRow.querySelector('.worktree-row-switch').disabled, 'Missing title is enabled')
      assert(
        [...otherRow.querySelectorAll('.worktree-signal')].every((b) => b.disabled),
        'Missing worktree detail controls are enabled',
      )
    } finally {
      smoke.store.setState({ tasks: originalTasks })
      await until('worktree restored', () => !otherRow.classList.contains('missing'))
    }
    click(otherRow.querySelector('.worktree-row-switch'))
    await until(
      'worktree selected',
      () =>
        state().activeTask === task.id && document.querySelector('[aria-label="Worktree panel"]'),
    )
    assert(
      state().sessions[mainSid]?.running && state().sessions[taskSid]?.running,
      'switching stopped terminals',
    )
    assert(!viewButton('Tasks'), 'Tasks view still exists')

    // The Plan picker lists both scopes and the worktree's changes.
    click(viewButton('Plan'))
    await openPicker()
    await until('worktree rows', () => document.querySelectorAll('.worktree-row').length === 2)
    await until('active worktree changes', () =>
      document.querySelector('.worktree-row.active')?.textContent.includes('±1'),
    )
    const activeRow = document.querySelector('.worktree-row.active')
    assert(
      signal(activeRow, 'Running').getAttribute('aria-label') === 'Running: 2',
      'worktree running count missing',
    )
    const bounds = document.querySelector('[aria-label="Worktree panel"]').getBoundingClientRect()
    assert(
      bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
      'picker outside viewport',
    )
    const notes = activeRow.querySelector('.worktree-notes-detail')
    if (!notes.open) click(notes.querySelector('summary'))
    edit(notes.querySelector('textarea'), 'smoke worktree notes')
    // Closing before the debounce expires must still save the edit.
    smoke.selectPanel(null)
    await until(
      'notes saved on close',
      () => state().tasks.find((t) => t.id === task.id)?.notes === 'smoke worktree notes',
    )
    click(viewButton('Build'))
    await openPicker()
    await until('Implementation worktree notes', () =>
      document.querySelector('.worktree-row.active')?.textContent.includes('smoke worktree notes'),
    )
    click(button(document.querySelector('.worktree-row.active'), 'Review'))
    await until(
      'Review action',
      () => state().view === 'review' && !!document.querySelector('.review-banner'),
    )

    // A plan saved in Plan belongs to the project and reaches its component agents there;
    // worktrees receive it at Implement (planHandoff.test.ts).
    state().updateComponent('web', {
      terminals: [
        ...state().nodes.find((n) => n.id === 'web').data.terminals,
        {
          id: 'brief',
          name: 'Brief',
          kind: 'agent',
          command: 'cat "$PATCHBAY_CONTEXT_FILE"; exec cat',
        },
      ],
    })
    click(viewButton('Plan'))
    click(await until('saved plan', () => document.querySelector('.plan-file summary')))
    const editor = await until('plan editor', () => {
      const el = document.querySelector('.plan-file textarea')
      return el && !el.disabled && el
    })
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
      editor,
      'smoke-plan-step-one',
    )
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const save = await until('plan save', () =>
      Array.from(document.querySelectorAll('.plan-file button')).find(
        (b) => b.textContent === 'Save' && !b.disabled,
      ),
    )
    click(save)
    await until('plan saved', () => save.disabled)
    const briefSid = smoke.sessionId('web', 'brief', null)
    await smoke.startTerminal('web', 'brief', null)
    await until(
      'plan in the agent briefing',
      () =>
        textOf(briefSid).includes('##Sharedplan') &&
        textOf(briefSid).includes('smoke-plan-step-one'),
    )

    // Two task workspaces retain layout and processes while proposals and CLI actions stay bound.
    secondTask = await smoke.createTask({
      title: 'Update API',
      branch: 'smoke/api',
      components: ['docs'],
    })
    state().setPanelLayout('task-split', { orientation: 2 })
    const secondShell = smoke.sessionId('@task', 'shell', secondTask.id)
    await smoke.startTerminal('@task', 'shell', secondTask.id)
    await until('second root shell', () => state().sessions[secondShell]?.running)
    state().setActiveTask(task.id)
    assert(state().highlighted.includes('web'), 'first task scope not restored')
    assert(!state().panels['task-split'], 'second task splits leaked into first')
    assert(
      !state().sessions[smoke.sessionId('@task', 'shell', task.id)]?.running,
      'new root shell auto-started',
    )
    click(viewButton('Build'))
    await until('Build view', () => document.querySelector('.implementation-view'))

    // A revealed terminal can belong to a different task from the visible workspace.
    state().setActiveTask(secondTask.id)
    smoke.store.setState({ revealed: { sid: taskSid, componentId: 'web' } })
    const revealedTile = () =>
      document.querySelector(`.task-terminal-grid [data-session="${taskSid}"]`)
    await until('other task terminal revealed', revealedTile)
    click(button(revealedTile(), '■ Stop'))
    await until('revealed terminal stopped', () => !state().sessions[taskSid]?.running)
    click(await until('revealed terminal restart', () => button(revealedTile(), '▶ Restart')))
    await until(
      'revealed terminal restarted in its own task',
      () => state().sessions[taskSid]?.running,
    )
    assert(state().activeTask === secondTask.id, 'tile restart switched tasks')
    assert(
      !state().sessions[smoke.sessionId('web', 'where', secondTask.id)]?.running,
      'tile restart launched in the active task instead of the displayed session',
    )
    smoke.store.setState({ revealed: null })
    state().setActiveTask(task.id)

    // The Worktree panel switches worktrees in Build, keeping terminals and layouts.
    const buildOverview = await openPicker()
    const secondRow = await until('second task in picker', () =>
      Array.from(buildOverview.querySelectorAll('.worktree-row')).find(
        (row) => row.querySelector('strong')?.textContent === secondTask.title,
      ),
    )
    click(secondRow.querySelector('.menu-trigger'))
    click(
      await until('Remove menu item', () =>
        [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Remove'),
      ),
    )
    await until('task removal options', () => secondRow.querySelector('.worktree-confirm'))
    assert(button(secondRow, 'Forget only'), 'task cannot be forgotten')
    assert(button(secondRow, 'Remove worktree'), 'worktree cannot be removed')
    click(button(secondRow, 'Cancel'))
    click(secondRow.querySelector('.worktree-row-switch'))
    await until('picker switched task', () => state().activeTask === secondTask.id)
    assert(state().panels['task-split'].orientation === 2, 'switching lost the split layout')
    assert(state().sessions[taskSid]?.running, 'switching stopped the other task terminal')
    state().setActiveTask(task.id)
    assert(!state().panels['task-split'], 'switching changed the first task layout')

    const proposal = {
      version: 1,
      plan: '# Agreed task plan\nImplement the login button.',
      assignments: [{ componentId: 'web', assignment: 'Add the login button and run checks.' }],
    }
    const plannerDevice = {
      id: 'smoke-planner',
      name: 'Smoke planner',
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: `printf '%s' '${JSON.stringify(proposal)}' > "$PATCHBAY_PLAN_FILE.input.json"; "$PATCHBAY_CLI" agent propose --file "$PATCHBAY_PLAN_FILE.input.json"; exec cat`,
    }
    state().setDevices([plannerDevice])
    click(viewButton('Plan'))
    const scopeBefore = [...state().highlighted]
    // The planner belongs to the project: asked for the task, it still runs in the project folder.
    await smoke.startTerminal('@plan', plannerDevice.id, task.id)
    const plannerSid = smoke.sessionId('@plan', plannerDevice.id, null)
    await until('planner CLI submission', () =>
      textOf(plannerSid).includes('"submitted":true'),
    ).catch((e) => {
      throw new Error(
        `${e.message}; message: ${state().message}; output: ${smoke.terminalText(plannerSid).text}`,
      )
    })
    assert(
      JSON.stringify(state().highlighted) === JSON.stringify(scopeBefore),
      'submission changed scope',
    )
    await until('proposed components outlined', () => state().proposedScope.includes('web'))
    click(
      await until('Apply selection', () =>
        button(document.querySelector('.proposed-scope'), 'Apply selection'),
      ),
    )
    await until(
      'proposal selection applied',
      () =>
        state().highlighted.join(',') === 'web' &&
        state()
          .tasks.find((t) => t.id === task.id)
          ?.components.join(',') === 'web',
    )
    await until(
      'applied proposal leaves the pending panel',
      () => !document.querySelector('.proposed-scope'),
    )
    assert(
      !state().rootTerminals.some((t) => t.kind === 'agent'),
      'proposal started an implementation agent',
    )

    const node = state().nodes.find((n) => n.id === 'web')
    state().updateComponent('web', {
      terminals: [
        ...node.data.terminals,
        {
          id: 'environment',
          name: 'Environment',
          kind: 'task',
          action: 'development',
          readyWhen: 'ENV READY',
          command: "printf 'ENV READY http://localhost:19991\\n'; exec cat",
        },
        {
          id: 'check',
          name: 'Check',
          kind: 'task',
          action: 'validation',
          command: 'sleep 1; printf "validated:%s\\n" "$PWD"',
        },
      ],
    })
    state().addGroup('Smoke environment', ['web'])
    const group = state().groups.find((g) => g.name === 'Smoke environment')
    state().updateGroup(group.id, { orderedStartup: true })
    // The app syncs the map to agents once edits settle; don't race that here.
    await smoke.syncAgentProject(state().toProject())
    const checkSid = smoke.sessionId('web', 'check', task.id)
    const worker = {
      id: 'smoke-worker',
      name: 'Smoke worker',
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: `cat "$PATCHBAY_CONTEXT_FILE"; "$PATCHBAY_CLI" agent context; "$PATCHBAY_CLI" agent environment start ${group.id}; "$PATCHBAY_CLI" agent validate web; "$PATCHBAY_CLI" agent validate docs; "$PATCHBAY_CLI" agent logs ${checkSid}; "$PATCHBAY_CLI" agent logs ${secondShell}; "$PATCHBAY_CLI" agent status; printf 'worker-finished\\n'; exec sh`,
    }
    state().setDevices([plannerDevice, worker])
    const rootAgent = state().addRootTerminal(worker)
    const rootAgentSid = smoke.sessionId('@task', rootAgent, task.id)
    click(viewButton('Build'))
    await smoke.startTerminal('@task', rootAgent, task.id)
    await until('root worker starts', () => state().sessions[rootAgentSid]?.running)
    state().setActiveTask(secondTask.id)
    const liveOverview = await openPicker()
    const backgroundRow = [...liveOverview.querySelectorAll('.worktree-row')].find(
      (row) => row.getAttribute('aria-label') === task.title,
    )
    await until(
      'worker finishes commands in background task',
      () => textOf(rootAgentSid).includes('worker-finished'),
      30000,
    )
    assert(state().activeTask === secondTask.id, 'agent request activated its task')
    assert(state().graphActionReport === null, 'background result leaked into active task')
    assert(
      textOf(rootAgentSid).includes('"taskId":"' + task.id + '"'),
      'CLI context followed active tab',
    )
    assert(
      textOf(rootAgentSid).includes('"missingValidators":["docs"]') &&
        textOf(rootAgentSid).includes('"passed":false'),
      'missing validator was accepted as passing',
    )
    assert(
      textOf(rootAgentSid).includes('Sessionisoutsidethelaunchtask'),
      'logs allowed another task',
    )
    assert(
      textOf(rootAgentSid).includes('validated:' + task.worktree + '/apps/web'),
      'validator used the wrong checkout',
    )
    assert(
      textOf(rootAgentSid).includes('Appliedassignments') &&
        textOf(rootAgentSid).includes('Addtheloginbutton'),
      'root briefing lost assignment',
    )
    assert(
      !textOf(rootAgentSid).includes('Youareplanning'),
      'planner instructions leaked into implementation',
    )
    assert(
      state().sessions[secondShell]?.running &&
        state().sessions[rootAgentSid]?.running &&
        state().sessions[taskSid]?.running,
      'tab switch stopped processes',
    )
    const validationResults = Object.values(state().taskActivities)
      .filter(
        (a) =>
          a.task === task.id &&
          ['validate', 'validateChanged', 'validateSelected'].includes(a.action.kind),
      )
      .flatMap((a) => a.report?.results ?? [])
    assert(validationResults.length > 0, 'No recorded validation results to check')
    await until(
      'live worktree validation count',
      () =>
        signal(backgroundRow, 'Tests').getAttribute('aria-label') ===
        `Tests: ${validationResults.length}`,
    )
    assert(
      Number(signal(backgroundRow, 'Issues').textContent) > 0,
      'Unseen actions did not update the issues count',
    )
    click(signal(backgroundRow, 'Issues'))
    const issueEntry = await until('worktree issue terminal', () =>
      backgroundRow.querySelector('[aria-label="Issues"] button.chip'),
    )
    click(issueEntry)
    await until('issue opens its worktree terminal', () => state().activeTask === task.id)
    state().setActiveTask(secondTask.id)
    click(signal(backgroundRow, 'Tests'))
    const testEntry = await until('recorded test terminal', () =>
      backgroundRow.querySelector('[aria-label="Tests"] button.chip'),
    )
    click(testEntry)
    await until(
      'test opens its worktree terminal',
      () =>
        state().activeTask === task.id &&
        validationResults.some((result) => result.sessionId === state().activeSession),
    )
    state().setActiveTask(task.id)
    smoke.selectPanel('activity')
    await until('initiating task activity visible', () =>
      document.querySelector('.task-activity')?.textContent.includes('Smoke worker'),
    )
    smoke.selectPanel(null)
    const activities = Object.values(state().taskActivities).filter(
      (a) => a.task === task.id && a.initiator === rootAgentSid,
    )
    assert(
      activities.length >= 3 &&
        activities.some((a) => a.previewUrls.includes('http://localhost:19991/')),
      'agent activity or preview URL missing',
    )
    // Implement saves the project plan's editor draft and hands it to the task's new agent.
    click(viewButton('Plan'))
    const savedPlan = await until('saved plan editor', () => document.querySelector('.plan-file'))
    if (!savedPlan.open) click(savedPlan.querySelector('summary'))
    const planEditor = await until('loaded applied plan', () => {
      const el = savedPlan.querySelector('textarea')
      return el && !el.disabled && el.value === proposal.plan ? el : null
    })
    const editedPlan = '# Edited implementation plan\nUse the draft from the Plan editor.'
    edit(planEditor, editedPlan)
    await until(
      'plan draft retained',
      () => button(savedPlan, 'Save') && !button(savedPlan, 'Save').disabled,
    )
    state().setDevices([
      plannerDevice,
      worker,
      {
        ...worker,
        id: 'draft-probe',
        name: 'Draft probe',
        command:
          'cat "$PATCHBAY_CONTEXT_FILE"; "$PATCHBAY_CLI" agent context; printf "draft-probe-ready\\n"; exec cat',
      },
    ])
    state().setPlanActive('draft-probe')
    const roots = state().rootTerminals.length
    click(
      await until('Implement in the task', () =>
        Array.from(document.querySelectorAll('.plan-implement button')).find((b) =>
          b.textContent.includes('Implement in'),
        ),
      ),
    )
    await until('implementation agent added', () => state().rootTerminals.length === roots + 1)
    const draftTerminal = state().rootTerminals.at(-1).id
    const draftSid = smoke.sessionId('@task', draftTerminal, task.id)
    await until('draft reaches implementation briefing', () =>
      textOf(draftSid).includes('draft-probe-ready'),
    )
    assert(
      textOf(draftSid).includes('UsethedraftfromthePlaneditor.'),
      'implementation received the old saved plan',
    )
    assert(
      textOf(draftSid).includes('"assignments":null'),
      'edited plan retained stale assignments',
    )

    // Required inaccessible consumers and environment members must never disappear from plans.
    const originalDocsPath = state().nodes.find((n) => n.id === 'docs').data.path
    state().updateComponent('docs', { path: 'missing-required-folder' })
    state().onConnect({ source: 'docs', target: 'web', sourceHandle: null, targetHandle: null })
    state().updateGroup(group.id, { componentIds: ['web', 'docs'] })
    // Sync the edited map before asking the already-running agent to use it.
    await smoke.syncAgentProject(state().toProject())
    await smoke.terminalWrite(
      rootAgentSid,
      `"$PATCHBAY_CLI" agent validate web; "$PATCHBAY_CLI" agent environment start ${group.id}; printf "inaccessible-finished\\n"\r`,
    )
    await until(
      'inaccessible actions rejected',
      () =>
        textOf(rootAgentSid).includes('inaccessible-finished') &&
        Object.values(state().taskActivities).filter(
          (a) =>
            a.task === task.id &&
            a.initiator === rootAgentSid &&
            a.error?.includes('missing or not allowed'),
        ).length >= 2,
    )
    state().updateComponent('docs', { path: originalDocsPath })
    state().onEdgesChange(state().edges.map((e) => ({ id: e.id, type: 'remove' })))
    state().updateGroup(group.id, { componentIds: ['web'] })
    // Existing agents use current configured commands, while their launch task remains fixed.
    state().updateTerminal('web', 'check', { command: 'printf live-validator; exit 7' })
    await smoke.syncAgentProject(state().toProject())
    await smoke.terminalWrite(
      rootAgentSid,
      '"$PATCHBAY_CLI" agent validate web; printf "live-config-finished\\n"\r',
    )
    await until(
      'updated validator in existing agent',
      () =>
        textOf(rootAgentSid).includes('live-config-finished') &&
        textOf(rootAgentSid).includes('"exitCode":7'),
    )
    state().updateTerminal('web', 'check', { command: 'sleep 1; exit 0' })
    await smoke.syncAgentProject(state().toProject())
    await smoke.terminalWrite(
      rootAgentSid,
      '"$PATCHBAY_CLI" agent validate web & "$PATCHBAY_CLI" agent validate web; wait; printf "contention-finished\\n"\r',
    )
    await until('bridge action contention', () =>
      textOf(rootAgentSid).includes('Anothergraphactionisstillrunningorstopping'),
    )
    await until(
      'contended action finished',
      () =>
        textOf(rootAgentSid).includes('contention-finished') &&
        !state().graphActionBusy &&
        !state().sessions[checkSid]?.running,
    )
    await smoke.terminalWrite(
      rootAgentSid,
      `"$PATCHBAY_CLI" agent environment stop ${group.id}; printf "agent-stop-finished\\n"\r`,
    )
    await until(
      'CLI environment stop',
      () =>
        textOf(rootAgentSid).includes('agent-stop-finished') &&
        textOf(rootAgentSid).includes('"stopped":true'),
    )
    assert(
      Object.values(state().taskActivities).some(
        (a) =>
          a.task === task.id &&
          a.initiator === rootAgentSid &&
          a.action.kind === 'environmentStop' &&
          a.state === 'finished',
      ),
      'agent environment stop is missing from task activity',
    )
    await smoke.stopGroup(group.id)
    state().removeGroup(group.id)
    await smoke.syncAgentProject(state().toProject())
    await smoke.terminalWrite(
      rootAgentSid,
      `"$PATCHBAY_CLI" agent environment start ${group.id}; printf "removed-group-finished\\n"\r`,
    )
    await until(
      'removed group rejected for existing agent',
      () =>
        textOf(rootAgentSid).includes('removed-group-finished') &&
        /unknowngroup/i.test(textOf(rootAgentSid)),
    )
    await smoke.removeTask(secondTask.id, true)
    assert(
      !(await smoke.sessionsList()).some((r) => r.metadata.task === secondTask.id),
      'removed worktree retained session records',
    )
    assert(
      !state().sessionRecords.some((r) => r.metadata.task === secondTask.id),
      'removed worktree sessions were not reconciled',
    )
    secondTask = undefined

    // git refuses to remove a dirty worktree; the task stays.
    click(viewButton('Build'))
    await openPicker()
    click(document.querySelector('.worktree-row.active .menu-trigger'))
    click(
      await until('Remove menu item', () =>
        [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === 'Remove'),
      ),
    )
    const confirm = await until('removal options', () =>
      document.querySelector('.worktree-confirm'),
    )
    assert(button(confirm, 'Forget only'), 'forget option missing')
    state().setMessage('')
    click(button(confirm, 'Remove worktree'))
    // git's own refusal, not a leftover message or a removal still in flight.
    await until('dirty worktree refusal', () =>
      /uncommitted or untracked changes/.test(state().message ?? ''),
    )
    await smoke.refreshTasks()
    assert(
      state().tasks.some((t) => t.id === task.id),
      'dirty worktree removed',
    )
    // A refused removal leaves the task's terminals running.
    assert(state().sessions[taskSid]?.running, 'a refused removal stopped task terminals')
    await smoke.terminalWrite(shellSid, 'rm smoke.txt\r')
    await sleep(800)
    click(button(document.querySelector('.worktree-confirm'), 'Remove worktree'))
    await until('worktree removed', () => !state().tasks.some((t) => t.id === task.id))
    // Removing stops the task's terminals, but not the open worktree's.
    await until('task terminals stopped', () => !state().sessions[taskSid]?.running)
    assert(state().sessions[mainSid]?.running, 'removing a task stopped the open worktree')
    assert(state().tasks.length === 0 && state().activeTask === null, 'task not removed')
    task = undefined

    // The Main worktree tab stands for the open checkout, so the dialog doesn't offer it again.
    click(
      await until('new task control', () =>
        button(document.querySelector('.task-tab-actions'), '＋ New task'),
      ),
    )
    const newTaskDialog = await until('new task dialog', () =>
      document.querySelector('[aria-label="New task"]'),
    )
    assert(!button(newTaskDialog, 'Current checkout'), 'dialog still offers the current checkout')
    click(button(newTaskDialog, 'Cancel'))
    await until('new task dialog closed', () => !document.querySelector('[aria-label="New task"]'))
    assert(state().sessions[mainSid]?.running, 'the dialog stopped the open checkout session')
    await smoke.report(
      'PASS tasks: isolated workspaces, planner proposal, root agent CLI, environment/checks, retained processes, remove',
    )
  } catch (e) {
    smoke.resetSessions(await smoke.terminalReset())
    if (secondTask) await smoke.removeTask(secondTask.id, false).catch(() => {})
    if (task) await smoke.removeTask(task.id, false).catch(() => {})
    await smoke.report(`FAIL tasks: ${e?.message ?? e}`)
  }
})()
