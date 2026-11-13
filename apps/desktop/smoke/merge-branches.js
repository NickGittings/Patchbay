// A feature branch in the primary checkout can merge into local main without another worktree.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (label, check, timeout = 25000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      await sleep(50)
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    }
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].find((el) => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
  const button = (text, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  try {
    smoke.acceptOpened(await smoke.openProject())
    await smoke.resizeWindow(1440, 900)
    const project = state().toProject()
    const root = project.root
    const parent = root.slice(0, root.lastIndexOf('/'))
    const chat = root.endsWith('/chat-primary')
    const merge = {
      id: 'merge-smoke',
      name: 'Merge fixture',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      command: `python3 '${parent}/agent.py'`,
    }
    const review = {
      ...merge,
      id: 'review-smoke',
      name: 'Review fixture',
      adapter: 'codex',
      command: `'${parent}/review-cli/codex'`,
    }
    state().setDevices([merge, review])
    state().setAgentRoles({ merge: [merge.id], review: [review.id] })
    await smoke.syncCurrentRoots()
    const original = await smoke.gitWorktrees(project.projectId)
    assert(
      original.length === 1 && original[0].main && original[0].branch === 'feature',
      'fixture must have only a primary feature checkout',
    )
    const originalHead = original[0].head
    if (chat) {
      state().setSimpleMode(true)
      await until('Chat mounted', () => visible('.simple-chat'))
      smoke.simpleUi.getState().patch(smoke.simpleKey(project.projectId, null), { changes: true })
      await until('initial committed comparison loaded', () =>
        visible('.simple-diff .change-row[data-path="shared.txt"]'),
      )
      // Seed a completed Build so Review must choose its own base, before any saved findings.
      const atMs = Date.now()
      const built = {
        id: 'fixture-build',
        metadata: {
          projectId: project.projectId,
          projectRoot: root,
          projectName: project.name,
          componentId: '@task',
          terminalId: 'fixture-build',
          task: null,
          name: 'Build fixture',
          kind: 'agent',
        },
        spec: { cwd: root, command: review.command },
        snapshot: { generation: 1, running: false, startedMs: atMs, exitCode: 0 },
        history: [],
      }
      smoke.store.setState({ sessionRecords: [...state().sessionRecords, built] })
      state().patchTask(project.projectId, null, {
        simple: {
          ...state().simple,
          log: [
            {
              id: 'fixture-build',
              kind: 'action',
              action: 'implement',
              stage: 'build',
              sessionId: built.id,
              generation: 1,
              atMs,
            },
          ],
        },
      })
      const start = await until('Chat Review enabled', () => {
        const b = button('Review', visible('.simple-step') ?? document)
        return b && !b.disabled && b
      })
      start.click()
      const reviewer = await until('Chat review starts without Options', () =>
        state().sessionRecords.find((r) => r.metadata.componentId === '@review'),
      )
      const sid = reviewer.id
      await until('review findings written', () =>
        smoke.terminalText(sid).text.includes('review-verified'),
      )
      state().patchTask(project.projectId, null, {
        simple: {
          ...state().simple,
          selectedAgent: sid,
          log: [
            ...(state().simple?.log ?? []),
            {
              id: 'fixture-review',
              kind: 'action',
              action: 'review',
              stage: 'review',
              sessionId: sid,
              generation: state().sessions[sid].generation,
              atMs: Date.now(),
            },
          ],
        },
      })
      await smoke.terminalStop(sid)
      await smoke.reconcileSessions()
      const finding = await until('review finding file link', () => visible('.finding-ref'))
      finding.click()
      await until(
        'finding opens the committed diff',
        () =>
          visible('.simple-diff .change-row[aria-selected="true"][data-path="shared.txt"]') &&
          visible('.simple-diff [data-new-line="1"]'),
      )
      assert(
        !visible('.simple-diff').textContent.includes('Diff unavailable'),
        'finding did not resolve after the review comparison reloaded',
      )
      const anyway = await until('Merge anyway with review findings', () => button('Merge anyway'))
      assert(!anyway.disabled, 'Merge anyway disabled without a destination checkout')
      anyway.click()
    } else {
      state().setSimpleMode(false)
      state().setView('review')
      const start = await until('Review merge enabled', () => {
        const b = visible('.review-merge-button')
        return b && !b.disabled && b
      })
      start.click()
    }
    const form = await until('shared branch dialog', () =>
      visible(chat ? 'form[aria-label="Merge"]' : 'form[aria-label="Start merge agent"]'),
    )
    assert(
      form.querySelector('[aria-label="Source worktree"]').value === root,
      'dialog changed the reviewed source',
    )
    const destinations = form.querySelector('[aria-label="Destination branch"]')
    assert(destinations.value === 'main', 'main was not the default destination')
    assert(
      destinations.selectedOptions[0].textContent.includes('Create worktree'),
      'new checkout not explained',
    )
    assert(
      ![...destinations.options].some((o) => o.value === 'feature'),
      'source branch offered as destination',
    )
    assert(
      (await smoke.gitWorktrees(project.projectId)).length === 1,
      'opening dialog created a checkout',
    )
    const beforeLog = [...(state().simple?.log ?? [])]
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const record = await until('destination merge launched', () =>
      state().sessionRecords.find((r) => r.metadata.componentId === '@merge'),
    )
    await until('merge verified', async () => {
      // Chat keeps terminals hidden until requested; read the service backlog directly.
      const snapshot = await smoke.terminalSnapshot(record.id)
      return snapshot && atob(snapshot.data).includes(`merge-verified:${record.spec.cwd}`)
    })
    const trees = await smoke.gitWorktrees(project.projectId)
    assert(trees.length === 2, 'merge did not create exactly one checkout')
    const source = trees.find((w) => w.path === root)
    assert(
      source.current && source.main && source.branch === 'feature' && source.head === originalHead,
      'source checkout changed',
    )
    assert(
      record.spec.cwd !== root && trees.find((w) => w.path === record.spec.cwd)?.branch === 'main',
      'agent did not run in main destination',
    )
    assert(state().activeTask === null, 'destination creation activated a task')
    assert(
      state().tasks.some((t) => t.worktree === record.spec.cwd),
      'created worktree missing from tasks',
    )
    if (chat) {
      assert(
        state().simpleMode && state().view === 'navigation' && visible('.simple-chat'),
        'merge left the source Chat',
      )
      assert(
        beforeLog.every((e) => state().simple.log.some((after) => after.id === e.id)),
        'merge lost source chat history',
      )
      assert(
        state().simple.log.some(
          (e) =>
            e.kind === 'action' &&
            e.action === 'merge' &&
            e.request?.destination === record.spec.cwd,
        ),
        'Chat did not log resolved request',
      )
    }
    await smoke.terminalStop(record.id)
    await smoke.report(
      `PASS merge-branches-${chat ? 'chat' : 'review'}: primary feature source, local main destination creation, isolated agent launch, task refresh, source/chat preservation`,
    )
  } catch (error) {
    await smoke.report(
      `FAIL merge-branches: ${error?.message ?? error} ${error?.stack ?? ''}; message=${state().message}; step=${visible('.simple-step')?.textContent}; chat=${visible('.simple-chat')?.textContent.slice(-1600)}`,
    )
  }
})()
