// Uses a local stand-in agent for real clean/conflicting Git merges without an AI account.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (label, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await sleep(50)
    }
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const click = (el) => {
    assert(el, 'missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const choose = (el, value) => {
    assert(el, 'missing select')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  // Worktree views stay mounted; assertions and clicks belong to the visible one.
  const visible = (selector) =>
    [...document.querySelectorAll(selector)].find((el) => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'
    })
  const dialog = () => visible('form[aria-label="Start merge agent"]')
  const submit = () =>
    dialog().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  const text = (sid) => smoke.terminalText(sid).text
  try {
    const opened = await smoke.openProject()
    state().loadProject(opened.project)
    const parent = opened.project.root.slice(0, opened.project.root.lastIndexOf('/'))
    const devices = [
      {
        id: 'merge-smoke',
        name: 'Smoke merge agent',
        kind: 'agent',
        category: 'agent',
        source: 'builtin',
        command: `python3 '${parent}/agent.py'`,
      },
    ]
    devices.push({
      id: 'fix-smoke',
      name: 'Smoke fix agent',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      adapter: 'codex',
      command: `'${parent}/fix-cli/codex'`,
    })
    devices.push({
      id: 'review-smoke',
      name: 'Smoke review agent',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      adapter: 'codex',
      command: `'${parent}/review-cli/codex'`,
    })
    state().setDevices([])
    await until('session service', () => state().serviceConnected)
    // Existing layouts from before the terminal was added have only the changes panel.
    state().setPanelLayout('ReviewView-merge', { 'ReviewView-changes': 100 })
    // Review follows the Worktree panel, so the feature worktree is a task.
    const task = await smoke.taskAttach(`${parent}/feature`, 'Feature fixes', [])
    await smoke.refreshTasks()
    await until('feature task registered', () => state().tasks.some((t) => t.id === task.id))
    state().setView('review')
    await until('Review mounted', () => visible('.review-refresh'))
    assert(!visible('.review-banner'), 'open worktree has a review banner')
    // Keep the diff request pending, then fail it, so both states are visible in the main pane.
    const originalFetch = window.fetch
    const reviewUrl = window.__TAURI_INTERNALS__.convertFileSrc('git_review', 'ipc')
    const pendingReviews = []
    window.fetch = (input, options) => {
      if (String(input) === reviewUrl && JSON.parse(options.body).worktree === `${parent}/feature`)
        return new Promise((resolve) => pendingReviews.push(resolve))
      return originalFetch(input, options)
    }
    try {
      state().setActiveTask(task.id)
      await until('diff request pending', () => pendingReviews.length)
      await until('diff loading message', () =>
        document
          .querySelector('.diff-view [role="status"]')
          ?.textContent.includes('Loading changes…'),
      )
      for (const resolve of pendingReviews)
        resolve(
          new Response('Smoke: review diff unavailable', {
            headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
          }),
        )
      await until('diff error message', () =>
        document
          .querySelector('.diff-view [role="alert"]')
          ?.textContent.includes('Smoke: review diff unavailable'),
      )
    } finally {
      window.fetch = originalFetch
    }
    click(visible('.review-refresh'))
    await until('source diff loaded against main', () =>
      visible('.diff-view .diff-file-path')?.textContent.includes('shared.txt'),
    )
    click(visible('.review-findings-button'))
    const emptyFindings = await until('unreviewed branch named in findings', () => {
      const empty = visible('.findings-panel .review-empty')
      return empty?.querySelector('code')?.textContent === 'feature' && empty
    })
    assert(
      !emptyFindings.textContent.includes('in Review'),
      'findings tell users already in Review to navigate to Review',
    )
    click(visible('.review-findings-button'))
    const banner = await until('worktree explanation', () => {
      const el = visible('.review-banner')
      return el?.textContent.includes('Feature fixes') && el
    })
    assert(banner.textContent.includes(`${parent}/feature`), 'review omitted worktree path')
    assert(banner.querySelector('code')?.textContent === 'feature', 'review omitted branch')
    // The merge dialog lists Review's worktrees as destinations; opens it while closed.
    const destinations = () => {
      if (!dialog()) click(visible('.review-merge-button'))
      return [
        ...(dialog()?.querySelectorAll('select[aria-label="Destination branch"] option') ?? []),
      ].map((o) => o.textContent)
    }
    const openDialog = () =>
      until('merge dialog', () => {
        if (dialog()) return dialog()
        // A worktree switch can still be committing its new dialog scope on the first click.
        click(visible('.review-merge-button'))
        return null
      })
    let form = await openDialog()
    state().setDevices(devices)
    await until(
      'agent preset loaded after opening dialog',
      () => form.querySelector('select[aria-label="Agent"]').value === 'merge-smoke',
    )
    assert(
      !form.querySelector('button[type="submit"]').disabled,
      'loaded preset did not enable Start',
    )
    assert(
      form.querySelector('select[aria-label="Destination branch"]').value === 'main',
      'destination did not default to the open worktree',
    )
    // Review runs alongside ordinary terminals, and findings survive view/session recovery.
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    click(visible('.review-agent-button'))
    let reviewForm = await until('review dialog', () =>
      visible('form[aria-label="Start review agent"]'),
    )
    assert(
      reviewForm.querySelector('select[aria-label="Base branch"]').value === 'main',
      'review base did not default to main',
    )
    // Several presets offer reviewer checkboxes; review with this one alone.
    const reviewerBoxes = () => [...reviewForm.querySelectorAll('.agent-job-agents input')]
    assert(reviewerBoxes().length > 1, 'missing reviewer checkboxes')
    state().setAgentRoles({ review: ['review-smoke'] })
    await until('review dialog follows role defaults', () =>
      reviewerBoxes().every((box) => box.checked === (box.value === 'review-smoke')),
    )
    for (const value of reviewerBoxes().map((box) => box.value)) {
      const box = reviewerBoxes().find((b) => b.value === value)
      if (box.checked !== (value === 'review-smoke')) box.click()
      await until(`reviewer ${value} set`, () =>
        reviewerBoxes().some((b) => b.value === value && b.checked === (value === 'review-smoke')),
      )
    }
    // Branches created elsewhere appear while the dialog stays open.
    await smoke.startTerminal('@task', 'shell', null)
    const branchShell = smoke.sessionId('@task', 'shell', null)
    await smoke.terminalWrite(branchShell, 'git branch review-base-refresh main\r')
    await until('new local review base appears', () =>
      [...reviewForm.querySelector('[aria-label="Base branch"]').options].some(
        (option) => option.value === 'review-base-refresh',
      ),
    )
    choose(reviewForm.querySelector('[aria-label="Base branch"]'), 'review-base-refresh')
    await until(
      'new branch selected',
      () => reviewForm.querySelector('[aria-label="Base branch"]').value === 'review-base-refresh',
    )
    await smoke.terminalWrite(branchShell, 'git branch -D review-base-refresh\r')
    await until(
      'removed review base returns to main',
      () => reviewForm.querySelector('[aria-label="Base branch"]').value === 'main',
    )
    reviewForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    reviewForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const reviewSid = await until('review session panel', () => {
      const el = visible('[aria-label="Review agent terminal"]')
      return el?.dataset.session
    })
    await until('review findings written without modifying the worktree', () =>
      text(reviewSid).includes('review-verified'),
    )
    const findingsFile = text(reviewSid)
      .split('review-file:')[1]
      .split(/[\r\n]/)[0]
    click(
      await until('review panel Findings button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Findings',
        ),
      ),
    )
    await until('saved Findings shown', () =>
      document
        .querySelector('.review-merge-terminal .findings-panel')
        ?.textContent.includes('Smoke review finding'),
    )
    const fixButton = () =>
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Fix in Build →',
      )
    assert(fixButton()?.disabled, 'partial findings enabled the fix handoff during review')
    await until('Reviewed status', () =>
      visible('.review-status')?.textContent.startsWith('Reviewed'),
    )
    click(visible('.review-findings-button'))
    await until('Review shows findings in place of the diff', () =>
      [...document.querySelectorAll('.review-view .findings-panel')]
        .find((el) => !el.closest('.review-merge-terminal'))
        ?.textContent.includes('Smoke review finding'),
    )
    click(visible('.review-findings-button'))
    await until(
      'Review findings pane closes',
      () =>
        ![...document.querySelectorAll('.review-view .findings-panel')].some(
          (el) => !el.closest('.review-merge-terminal'),
        ),
    )
    click(visible('.review-agent-button'))
    reviewForm = await until('running review guard', () =>
      visible('form[aria-label="Start review agent"]'),
    )
    assert(
      reviewForm.querySelector('button[type="submit"]').disabled,
      'running review was not blocked',
    )
    click([...reviewForm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    await smoke.terminalWrite(reviewSid, '\r')
    await until('reviewer settles at its prompt', () => text(reviewSid).includes('review-idle'))
    await until(
      'an idle running reviewer allows the fix handoff',
      () => fixButton() && !fixButton().disabled,
    )
    assert(state().sessions[reviewSid]?.running, 'reviewer exited before settling')
    await smoke.terminalWrite(reviewSid, '\r')
    await until(
      'review exits successfully',
      () =>
        state().sessions[reviewSid]?.running === false &&
        state().sessions[reviewSid]?.exitCode === 0,
    )
    const beforeFix = state().rootTerminals.length
    click(
      await until('review panel Findings button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Findings',
        ),
      ),
    )
    await until(
      'fix enabled without showing Findings',
      () => !visible('.review-merge-terminal .findings-panel'),
    )
    click(
      await until('fix handoff enabled', () => fixButton() && !fixButton().disabled && fixButton()),
    )
    await until('fix handoff opens Implementation', () => state().view === 'implementation')
    assert(state().activeTask === task.id, 'fix handoff did not activate the reviewed task')
    assert(
      state().rootTerminals.length === beforeFix + 1,
      'fix handoff did not create a new root terminal',
    )
    const fixTerminal = state().rootTerminals.at(-1)
    assert(fixTerminal.adapter === 'codex', 'fix handoff did not preserve the reviewer provider')
    const fixSid = smoke.sessionId('@task', fixTerminal.id, task.id)
    await until('fix agent receives inline findings', () => text(fixSid).includes('fix-verified:'))
    assert(text(fixSid).includes('## Review findings'), 'fix briefing omitted Review findings')
    await until('fix fixture exits', () => state().sessions[fixSid]?.running === false)
    const fixRecord = await until('fix session record', () =>
      state().sessionRecords.find((r) => r.id === fixSid),
    )
    assert(
      fixRecord?.spec.cwd === task.worktree,
      'fix agent did not launch in the reviewed worktree',
    )
    assert(
      !fixRecord.spec.dirs?.some((dir) => dir.endsWith('/patchbay/reviews')),
      'fix agent was granted the reviews folder',
    )
    state().setActiveTask(null)
    state().setView('review')
    await until('Review returns after fix launch', () => visible('.review-refresh'))
    click(
      await until('review panel Hide button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Hide',
        ),
      ),
    )
    await until('review panel hidden', () => !visible('.review-merge-terminal'))
    state().setView('navigation')
    await until('left hidden review', () => !visible('.review-view'))
    state().setView('review')
    await until('Review restored', () => visible('.review-refresh'))
    assert(!visible('.review-merge-terminal'), 'hidden review reopened on remount')
    click(
      [...document.querySelectorAll('.review-view button')].find(
        (b) => b.textContent === 'Show agents',
      ),
    )
    await until(
      'review recovered from record',
      () => visible('.review-merge-terminal')?.dataset.session === reviewSid,
    )
    assert(!state().dockKept.includes(reviewSid), 'review entered the dock')
    assert(
      state().sessionRecords.filter((r) => r.metadata.componentId === '@review').length === 1,
      'duplicate review launched twice',
    )
    state().setActiveTask(task.id)
    form = await openDialog()
    await until('merge dialog shows current review', () =>
      form.querySelector('[aria-label="Source review status"]')?.textContent.includes('current'),
    )
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    await smoke.startTerminal('@task', 'shell', null)
    const fixtureShell = smoke.sessionId('@task', 'shell', null)
    await smoke.terminalWrite(
      fixtureShell,
      `git -C '${parent}/feature' commit --allow-empty -qm 'After review'; printf "AFTER-REVIEW-FIXTURE\\n"\r`,
    )
    await until('fixture commit', () => text(fixtureShell).includes('\nAFTER-REVIEW-FIXTURE\n'))
    window.dispatchEvent(new Event('focus'))
    await until(
      'Changed since review status',
      () => visible('.review-status')?.textContent === 'Changed since review',
    )
    form = await openDialog()
    await until('merge dialog shows stale review', () =>
      form
        .querySelector('[aria-label="Source review status"]')
        ?.textContent.includes('changed since review'),
    )
    // Backend errors remain in the dialog, and do not launch an agent.
    await smoke.startTerminal('@task', 'shell', null)
    const shell = smoke.sessionId('@task', 'shell', null)
    await smoke.terminalWrite(
      shell,
      'printf dirty > merge-smoke-untracked; printf "DIRTY-MERGE-FIXTURE\\n"\r',
    )
    await until('shell wrote dirty file', () => text(shell).includes('\nDIRTY-MERGE-FIXTURE\n'))
    submit()
    await until('dirty destination error', () =>
      dialog()
        ?.querySelector('[role="alert"]')
        ?.textContent.includes('destination worktree has uncommitted'),
    )
    assert(
      !state().sessionRecords.some((r) => r.metadata.componentId === '@merge'),
      'dirty destination launched an agent',
    )
    await smoke.terminalWrite(shell, 'rm merge-smoke-untracked; printf "CLEAN-MERGE-FIXTURE\\n"\r')
    await until('dirty file removed', () => text(shell).includes('\nCLEAN-MERGE-FIXTURE\n'))
    choose(form.querySelector('select[aria-label="Destination branch"]'), 'integration')
    submit()
    submit() // Repeated submit must produce a single launch.
    await until('merge terminal', () => visible('[aria-label="Merge agent terminal"]'))
    assert(
      document
        .querySelector('select[aria-label="Agent session"]')
        .selectedOptions[0].textContent.includes(`${parent}/integration`),
      'merge session label omitted its destination',
    )
    let sid = visible('.review-merge-terminal').dataset.session
    const mergeHeight = () => visible('.review-merge-terminal')?.getBoundingClientRect().height ?? 0
    await until('usable merge panel on first launch', () => mergeHeight() > 100)
    const openHeight = mergeHeight()
    assert(
      !visible('.review-merge-terminal .terminal-overlay button'),
      'merge pane offered generic Start',
    )
    click(
      await until('review panel Hide button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Hide',
        ),
      ),
    )
    await until('merge panel collapsed', () => !visible('.review-merge-terminal'))
    await until(
      'collapsed merge size saved',
      () => state().panels['ReviewView-merge']['ReviewView-merge-terminal'] === 0,
    )
    // Hide survives view changes, and an explicit reveal works even when already active.
    state().setView('navigation')
    await until('left hidden Review', () => !visible('.review-view'))
    state().setView('review')
    await until('hidden Review restored', () => visible('.review-view'))
    assert(!visible('.review-merge-terminal'), 'hidden merge reopened on remount')
    click(
      [...document.querySelectorAll('.review-view button')].find(
        (b) => b.textContent === 'Show agents',
      ),
    )
    await until(
      'merge panel reopened at its remembered size',
      () => Math.abs(mergeHeight() - openHeight) < 3,
    )
    click(
      await until('review panel Hide button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Hide',
        ),
      ),
    )
    await until('merge hidden again', () => !visible('.review-merge-terminal'))
    const priorSession = state().sessions[sid]
    state().setSession(sid, {
      ...priorSession,
      status: {
        ...priorSession.status,
        agent: { state: 'needsInput', sinceMs: Date.now(), message: 'Smoke input', prompt: null },
      },
    })
    click(
      await until('merge attention entry', () => {
        // Mounting a restored terminal can move focus and close the synthetic popup.
        // Session reconciliation can also replace this local stand-in status.
        if (state().sessions[sid]?.status?.agent?.state !== 'needsInput')
          state().setSession(sid, {
            ...state().sessions[sid],
            status: {
              ...state().sessions[sid]?.status,
              agent: {
                state: 'needsInput',
                sinceMs: Date.now(),
                message: 'Smoke input',
                prompt: null,
              },
            },
          })
        const entry = [...document.querySelectorAll('.attention-item')].find((b) =>
          b.textContent.includes('Merge agent'),
        )
        if (entry) return entry
        smoke.selectPanel('activity')
        return null
      }),
    )
    await until('attention reveals the already active merge', () => mergeHeight() > 100)
    assert(!state().dockKept.includes(sid), 'merge was retained in the Navigation dock')
    state().setSession(sid, priorSession)
    state().setActiveTask(task.id)
    await until('clean merge verified', () =>
      text(sid).includes(`merge-verified:${parent}/integration`),
    )
    assert(
      text(sid).replace(/\s+/g, '').includes(findingsFile.replace(/\s+/g, '')),
      'merge briefing did not name the findings file',
    )
    assert(text(sid).includes('merge-result:clean'), 'clean destination did not merge cleanly')
    assert(
      state().sessionRecords.filter((r) => r.metadata.componentId === '@merge').length === 1,
      'duplicate submit launched twice',
    )
    assert(state().activeTask === task.id, 'launch switched the reviewed source')
    form = await openDialog()
    choose(form.querySelector('select[aria-label="Destination branch"]'), 'integration')
    await until(
      'running destination blocked',
      () => dialog()?.querySelector('button[type="submit"]').disabled,
    )
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    state().setView('navigation')
    await until('left Review', () => !visible('.review-view'))
    state().setView('review')
    await until(
      'recovered merge terminal',
      () => visible('.review-merge-terminal')?.dataset.session === sid,
    )
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find((b) =>
        b.textContent.includes('Stop'),
      ),
    )
    await until('merge stopped', () => state().sessions[sid]?.running === false)
    const cleanupPrompt = await until('post-merge cleanup popup', () =>
      visible('[role="dialog"][aria-label="Merge complete"]'),
    )
    assert(cleanupPrompt.textContent.includes('feature'), 'cleanup popup omitted the source branch')
    assert(
      cleanupPrompt.textContent.includes('integration'),
      'cleanup popup omitted the destination',
    )
    click([...cleanupPrompt.querySelectorAll('button')].find((b) => b.textContent === 'Keep'))
    await until('cleanup dismissed', () => !visible('[role="dialog"][aria-label="Merge complete"]'))
    await sleep(2200)
    assert(!visible('[role="dialog"][aria-label="Merge complete"]'), 'cleanup popup repeated')
    assert(
      state().tasks.some((t) => t.id === task.id),
      'Keep removed the source task',
    )
    state().setView('navigation')
    await until('Navigation mounted after stopping merge', () => visible('.canvas'))
    assert(
      ![...document.querySelectorAll('.terminal-dock .tab')].some((tab) =>
        tab.textContent.includes('Merge'),
      ),
      'stopped merge entered Navigation restart flow',
    )
    assert(!state().runtimeTerminals[sid], 'merge registered a generic runtime terminal')
    assert(!state().dockKept.includes(sid), 'stopped merge was retained in the dock')
    state().setView('review')
    await until('Review restored after Navigation', () =>
      visible('.review-banner')?.textContent.includes('Feature fixes'),
    )
    await smoke.terminalWrite(
      shell,
      `git -C '${parent}/integration' branch -m refreshed-integration; printf "BRANCH-RENAMED\\n"\r`,
    )
    await until('terminal branch rename', () => text(shell).includes('\nBRANCH-RENAMED\n'))
    await until('worktree poll updates destination branch', () =>
      destinations().some((o) => o.includes('refreshed-integration')),
    )
    click([...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    await smoke.terminalWrite(
      shell,
      `git -C '${parent}/integration' branch -m integration; printf "BRANCH-RESTORED\\n"\r`,
    )
    await until('terminal branch restored', () => text(shell).includes('\nBRANCH-RESTORED\n'))
    window.dispatchEvent(new Event('focus'))
    await until('focus updates destination branch', () =>
      destinations().some((o) => o.startsWith('integration ·')),
    )
    click([...dialog().querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    form = await openDialog()
    choose(form.querySelector('select[aria-label="Destination branch"]'), 'integration')
    await until('stopped destination available again', () => {
      // A branch refresh may close the old source scope while this dialog is opening.
      if (!dialog()) {
        click(visible('.review-merge-button'))
        return false
      }
      form = dialog()
      const select = form.querySelector('select[aria-label="Destination branch"]')
      if (select.value !== 'integration') choose(select, 'integration')
      return !form.querySelector('button[type="submit"]').disabled
    })
    // A clean but still-running terminal must not share the merge destination.
    await smoke.terminalStop(shell)
    await until('destination shell stopped', () => state().sessions[shell]?.running === false)
    click(
      await until('review panel Hide button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Hide',
        ),
      ),
    )
    // Forgetting the hidden merge must not collapse the next merge, even before selection.
    await smoke.sessionForget(sid)
    await smoke.reconcileSessions()
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    state().setActiveTask(null)
    await until('Main worktree Review rendered', () => !visible('.review-banner'))
    form = await openDialog()
    const sourceSelect = () => form.querySelector('select[aria-label="Source worktree"]')
    const destinationSelect = () => form.querySelector('select[aria-label="Destination branch"]')
    assert(sourceSelect().value === opened.project.root, 'reviewed source was not preselected')
    assert(destinationSelect().value === '', 'nonstandard destination was selected automatically')
    assert(form.querySelector('button[type="submit"]').disabled, 'missing source allowed launch')
    choose(sourceSelect(), `${parent}/feature`)
    choose(destinationSelect(), 'main')
    await until(
      'incoming merge ready with feature findings',
      () =>
        !form.querySelector('button[type="submit"]').disabled &&
        form
          .querySelector('[aria-label="Source review status"]')
          ?.textContent.includes('changed since review'),
    )
    assert(destinationSelect().value === 'main', 'source choice changed main destination')
    assert(
      ![...destinationSelect().options].some((o) => o.value === 'feature'),
      'source was offered as a destination',
    )
    choose(sourceSelect(), opened.project.root)
    assert(destinationSelect().value === '', 'invalid destination survived source change')
    assert(form.querySelector('button[type="submit"]').disabled, 'same worktree allowed launch')
    choose(sourceSelect(), `${parent}/feature`)
    choose(destinationSelect(), 'main')
    submit()
    await until('conflict destination terminal', () => {
      const el = visible('.review-merge-terminal')
      return el?.dataset.session !== sid && el
    })
    sid = visible('.review-merge-terminal').dataset.session
    await until('conflict merge verified', () =>
      text(sid).includes(`merge-verified:${opened.project.root}`),
    )
    assert(state().activeTask === null, 'incoming merge switched away from Main worktree')
    assert(text(sid).includes('Source branch: feature'), 'incoming merge used wrong source')
    assert(
      text(sid).includes('merge-result:resolved-conflict'),
      'conflicting destination was not resolved',
    )
    assert(
      visible('.review-merge-terminal .terminal-area').getBoundingClientRect().height > 60,
      'merge terminal has no usable height',
    )
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find((b) =>
        b.textContent.includes('Stop'),
      ),
    )
    await until('second merge stopped', () => state().sessions[sid]?.running === false)
    const secondCleanup = await until('incoming merge cleanup popup', () =>
      visible('[role="dialog"][aria-label="Merge complete"]'),
    )
    click([...secondCleanup.querySelectorAll('button')].find((b) => b.textContent === 'Keep'))
    await until(
      'incoming cleanup dismissed',
      () => !visible('[role="dialog"][aria-label="Merge complete"]'),
    )
    click(
      await until('review panel Hide button', () =>
        [...document.querySelectorAll('.review-merge-terminal button')].find(
          (b) => b.textContent === 'Hide',
        ),
      ),
    )
    await until('finished merge hidden', () => !visible('.review-merge-terminal'))
    // Restore the task's dock for the existing finished-session recovery checks.
    state().setActiveTask(task.id)
    state().setView('navigation')
    await until('left finished merge Review', () => !visible('.review-view'))
    state().setView('review')
    await until('finished merge Review remounted', () => visible('.review-view'))
    assert(!visible('.review-merge-terminal'), 'finished hidden merge reopened on remount')
    await smoke.reconcileSessions()
    smoke.selectPanel('sessions')
    choose(
      await until('session filter', () => visible('select[aria-label="Filter sessions"]')),
      'all',
    )
    // Only once it has ended: a running row has neither Show in Review nor (without an
    // adapter) a menu.
    const mergeRow = await until('finished destination session row', () =>
      [...document.querySelectorAll('.session-row')].find((r) => {
        const cwd = r.title
        const state = r.querySelector(':scope > .status-dot')?.title
        return (
          !!r.querySelector('.session-role.merge') &&
          cwd === opened.project.root &&
          (state === 'Ended' || state === 'Interrupted')
        )
      }),
    )
    // Inline when the row has room (no Resume), otherwise in the row's menu.
    const showInReview = (scope) =>
      [...scope.querySelectorAll('button')].find((b) => b.textContent === 'Show in Review')
    // Present but briefly disabled (busy) still means inline: only open the menu when absent.
    if (!showInReview(mergeRow)) click(mergeRow.querySelector('.session-menu .menu-trigger'))
    const reviewMerge = await until('Review merge action for finished destination', () => {
      const button = showInReview(document.body)
      return button && !button.disabled && button
    })
    click(reviewMerge)
    await until(
      'Sessions reveals finished merge despite unchanged active session',
      () => visible('.review-merge-terminal')?.dataset.session === sid && mergeHeight() > 100,
    )
    assert(!state().dockKept.includes(sid), 'finished merge was retained in the dock')
    await smoke.terminalStop(shell)
    await smoke.report(
      'PASS merge: review findings/read-only fixture/staleness/recovery and Fix in Build handoff, dirty destination errors, defaults, clean/conflict merges, duplicate prevention, panel sizing/Hide persistence, Sessions/Attention reveal, branch polling/focus refresh, Navigation exclusion, Review terminal recovery and Stop',
    )
  } catch (e) {
    await smoke.report(
      `FAIL merge: ${e?.message ?? e} ${e?.stack ?? ''}; findings: ${visible('.findings-panel')?.textContent}`,
    )
  }
})()
