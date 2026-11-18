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
  let stopAnswering = () => {}
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
      command: `PATCHBAY_SMOKE_CLEANUP_ARTIFACT=1 python3 '${parent}/agent.py'`,
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
      visible(
        chat
          ? '[role="dialog"][aria-label="Merge"] form'
          : '[role="dialog"][aria-label="Start merge agent"] form',
      ),
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
    await smoke.reconcileSessions()
    const retry = await until('cleanup validation retry', () => button('Retry validation'))
    const blockedCleanup = button('Delete worktree and branch')
    assert(blockedCleanup?.disabled, 'dirty destination must block cleanup')
    const removeArtifact = state().addRootTerminal({
      id: 'remove-cleanup-artifact',
      name: 'Remove test artifact',
      command: `rm -- '${record.spec.cwd}/cleanup-artifact.txt'`,
      kind: 'task',
    })
    await smoke.startTerminal('@task', removeArtifact, null)
    const removeSession = smoke.sessionId('@task', removeArtifact, null)
    await until('test artifact removed', async () => {
      const snapshot = await smoke.terminalSnapshot(removeSession)
      return snapshot && !snapshot.running && snapshot.exitCode === 0
    })
    retry.click()
    const cleanup = await until('restore original worktree offered', () =>
      button('Return to main and delete feature branch'),
    )
    assert(!cleanup.disabled, 'restoration cleanup is disabled')
    cleanup.click()
    await until('original folder restored and generated worktree removed', async () => {
      const after = await smoke.gitWorktrees(project.projectId)
      return after.length === 1 && after[0].path === root && after[0].branch === 'main'
    })
    await until(
      'generated task retired',
      () => !state().tasks.some((t) => t.worktree === record.spec.cwd),
    )
    assert(state().activeTask === null, 'cleanup changed the active project')
    await until(
      'footer branch refreshed after restoration',
      () =>
        document
          .querySelector(
            '.workspace-context [aria-label="Switch branch"] .workspace-context-branch',
          )
          ?.textContent.trim() === 'main',
    )
    smoke.selectPanel('worktree')
    const branchButton = await until('source branch controls', () => button('Branches'))
    branchButton.click()
    const region = await until('source branch list', () => {
      const el = document.querySelector('[aria-label="Source branches"]')
      return el?.querySelector('option[value="unused"]') && el
    })
    const choose = (label, value) => {
      const select = region.querySelector(`[aria-label="${label}"]`)
      select.value = value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const waitBranch = (branch) =>
      until(`source on ${branch}`, async () => {
        const current = (await smoke.gitWorktrees(project.projectId)).find((t) => t.current)
        return (
          current?.branch === branch &&
          region.querySelector('code')?.textContent === branch &&
          !region.querySelector('select').disabled
        )
      })
    const shell = smoke.sessionId('@task', 'shell', null)
    const agentTerminal = state().addRootTerminal({
      id: 'branch-agent',
      name: 'Branch agent',
      command: 'cat',
      kind: 'agent',
    })
    const agent = smoke.sessionId('@task', agentTerminal, null)
    const startWriters = async () => {
      await smoke.startTerminal('@task', 'shell', null)
      await smoke.startTerminal('@task', agentTerminal, null)
      await until(
        'branch writers running',
        async () =>
          (await smoke.terminalSnapshot(shell))?.running &&
          (await smoke.terminalSnapshot(agent))?.running,
      )
    }
    await startWriters()
    let approveStop = false
    const prompts = []
    stopAnswering = smoke.answerConfirms((message) => {
      prompts.push(message)
      return approveStop
    })
    const footerSwitch = document.querySelector('.workspace-context [aria-label="Switch branch"]')
    assert(footerSwitch, 'footer branch selector missing')
    footerSwitch.click()
    const unusedChoice = await until('footer unused branch choice', () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].find((el) =>
        el.textContent.trim().startsWith('unused'),
      ),
    )
    unusedChoice.click()
    await until('stop confirmation cancelled', () => prompts.length === 1)
    await waitBranch('main')
    assert(
      (await smoke.terminalSnapshot(shell))?.running &&
        (await smoke.terminalSnapshot(agent))?.running,
      'cancelling a branch switch stopped running work',
    )
    assert(prompts[0].includes('unused') && prompts[0].includes(root), 'wrong switch prompt')
    approveStop = true
    footerSwitch.click()
    const retryChoice = await until('footer switch retry', () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].find((el) =>
        el.textContent.trim().startsWith('unused'),
      ),
    )
    retryChoice.click()
    await waitBranch('unused')
    assert(
      !(await smoke.terminalSnapshot(shell))?.running &&
        !(await smoke.terminalSnapshot(agent))?.running,
      'confirmed footer switch left writers running',
    )
    const renameInput = region.querySelector('[aria-label="New source branch name"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
      renameInput,
      'finished',
    )
    renameInput.dispatchEvent(new Event('input', { bubbles: true }))
    button('Rename branch', region).click()
    await waitBranch('finished')
    await startWriters()
    choose('Switch source branch', 'main')
    button('Switch branch', region).click()
    await waitBranch('main')
    assert(prompts.length === 3, 'both branch controls must prompt for running writers')
    assert(
      !(await smoke.terminalSnapshot(shell))?.running &&
        !(await smoke.terminalSnapshot(agent))?.running,
      'confirmed source switch left writers running',
    )
    choose('Delete local branch', 'finished')
    button('Delete branch', region).click()
    const confirmDelete = await until('branch deletion confirmation', () => {
      const confirm = region.querySelector('.worktree-confirm')
      return confirm && button('Delete branch', confirm)
    })
    confirmDelete.click()
    await until(
      'unused local branch deleted',
      () =>
        !region.querySelector('option[value="finished"]') &&
        !region.querySelector('select').disabled,
    )
    assert(
      region.getBoundingClientRect().width <=
        region.parentElement.getBoundingClientRect().width + 1,
      'source branch panel overflows its worktree card',
    )
    await smoke.report(
      `PASS merge-branches-${chat ? 'chat' : 'review'}: primary feature source, local main destination creation, isolated agent launch, task refresh, source/chat preservation, cleanup restoration, source branch switch/rename/delete, footer and source switches confirm stopping writers, cancellation preserves running work`,
    )
  } catch (error) {
    await smoke.report(
      `FAIL merge-branches: ${error?.message ?? error} ${error?.stack ?? ''}; message=${state().message}; step=${visible('.simple-step')?.textContent}; chat=${visible('.simple-chat')?.textContent.slice(-1600)}`,
    )
  } finally {
    stopAnswering()
  }
})()
