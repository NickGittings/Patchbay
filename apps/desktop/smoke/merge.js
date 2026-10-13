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
  const dialog = () => document.querySelector('form[aria-label="Start merge agent"]')
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
      command: `python3 '${parent}/fix.py'`,
    })
    devices.push({
      id: 'review-smoke',
      name: 'Smoke review agent',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      adapter: 'codex',
      command: `python3 '${parent}/review.py'`,
    })
    state().setDevices([])
    await until('session service', () => state().serviceConnected)
    // Existing layouts from before the terminal was added have only the changes panel.
    state().setPanelLayout('ReviewView-merge', { 'ReviewView-changes': 100 })
    state().setView('review')
    const picker = await until('worktree picker', () => document.querySelector('.review-worktree'))
    choose(picker, `${parent}/feature`)
    await until('clean source review', () => document.querySelector('.review-empty'))
    const openDialog = async () => {
      click(document.querySelector('.review-merge-button'))
      return until('merge dialog', dialog)
    }
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
      form.querySelector('select[aria-label="Destination worktree"]').value === opened.project.root,
      'destination did not default to the open worktree',
    )
    // Review runs alongside ordinary terminals, and findings survive view/session recovery.
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    click(document.querySelector('.review-agent-button'))
    let reviewForm = await until('review dialog', () =>
      document.querySelector('form[aria-label="Start review agent"]'),
    )
    assert(
      reviewForm.querySelector('select[aria-label="Base branch"]').value === 'main',
      'review base did not default to main',
    )
    choose(reviewForm.querySelector('select[aria-label="Agent"]'), 'review-smoke')
    reviewForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    reviewForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    const reviewSid = await until('review session panel', () => {
      const el = document.querySelector('[aria-label="Review agent terminal"]')
      return el?.dataset.session
    })
    await until('review findings written without modifying the worktree', () =>
      text(reviewSid).includes('review-verified'),
    )
    const findingsFile = text(reviewSid)
      .split('review-file:')[1]
      .split(/[\r\n]/)[0]
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Findings',
      ),
    )
    await until('saved Findings shown', () =>
      document.querySelector('.review-findings pre')?.textContent.includes('Smoke review finding'),
    )
    const fixButton = () =>
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Fix in Implementation →',
      )
    assert(fixButton()?.disabled, 'partial findings enabled the fix handoff during review')
    await until('Reviewed status', () =>
      document.querySelector('.review-status')?.textContent.startsWith('Reviewed'),
    )
    click(document.querySelector('.review-agent-button'))
    reviewForm = await until('running review guard', () =>
      document.querySelector('form[aria-label="Start review agent"]'),
    )
    assert(
      reviewForm.querySelector('button[type="submit"]').disabled,
      'running review was not blocked',
    )
    click([...reviewForm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    await smoke.terminalWrite(reviewSid, '\r')
    await until(
      'review exits successfully',
      () =>
        state().sessions[reviewSid]?.running === false &&
        state().sessions[reviewSid]?.exitCode === 0,
    )
    const task = await smoke.taskAttach(`${parent}/feature`, 'Feature fixes', [])
    await smoke.refreshTasks()
    await until('reviewed task registered', () => state().tasks.some((t) => t.id === task.id))
    const beforeFix = state().rootTerminals.length
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Findings',
      ),
    )
    await until(
      'fix enabled without showing Findings',
      () => !document.querySelector('.review-findings'),
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
    await until('Review returns after fix launch', () => document.querySelector('.review-worktree'))
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Hide',
      ),
    )
    await until('review panel hidden', () => !document.querySelector('.review-merge-terminal'))
    state().setView('navigation')
    await until('left hidden review', () => !document.querySelector('.review-view'))
    state().setView('review')
    await until('Review restored', () => document.querySelector('.review-worktree'))
    assert(!document.querySelector('.review-merge-terminal'), 'hidden review reopened on remount')
    click(
      [...document.querySelectorAll('.review-view button')].find(
        (b) => b.textContent === 'Show agents',
      ),
    )
    await until(
      'review recovered from record',
      () => document.querySelector('.review-merge-terminal')?.dataset.session === reviewSid,
    )
    assert(!state().dockKept.includes(reviewSid), 'review entered the dock')
    assert(
      state().sessionRecords.filter((r) => r.metadata.componentId === '@review').length === 1,
      'duplicate review launched twice',
    )
    choose(document.querySelector('.review-worktree'), `${parent}/feature`)
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
      () => document.querySelector('.review-status')?.textContent === 'Changed since review',
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
    choose(form.querySelector('select[aria-label="Destination worktree"]'), `${parent}/integration`)
    submit()
    submit() // Repeated submit must produce a single launch.
    await until('merge terminal', () =>
      document.querySelector('[aria-label="Merge agent terminal"]'),
    )
    let sid = document.querySelector('.review-merge-terminal').dataset.session
    const mergeHeight = () =>
      document.querySelector('.review-merge-terminal')?.getBoundingClientRect().height ?? 0
    await until('usable merge panel on first launch', () => mergeHeight() > 100)
    const openHeight = mergeHeight()
    assert(
      !document.querySelector('.review-merge-terminal .terminal-overlay button'),
      'merge pane offered generic Start',
    )
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Hide',
      ),
    )
    await until('merge panel collapsed', () => !document.querySelector('.review-merge-terminal'))
    await until(
      'collapsed merge size saved',
      () => state().panels['ReviewView-merge']['ReviewView-merge-terminal'] === 0,
    )
    // Hide survives view changes, and an explicit reveal works even when already active.
    state().setView('navigation')
    await until('left hidden Review', () => !document.querySelector('.review-view'))
    state().setView('review')
    await until('hidden Review restored', () => document.querySelector('.review-view'))
    assert(!document.querySelector('.review-merge-terminal'), 'hidden merge reopened on remount')
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
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Hide',
      ),
    )
    await until('merge hidden again', () => !document.querySelector('.review-merge-terminal'))
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
        const trigger = document.querySelector('.attention-button')
        if (trigger && trigger.getAttribute('aria-expanded') !== 'true') click(trigger)
        return null
      }),
    )
    await until('attention reveals the already active merge', () => mergeHeight() > 100)
    assert(!state().dockKept.includes(sid), 'merge was retained in the Navigation dock')
    state().setSession(sid, priorSession)
    // The picker is local to Review; restore it after the remount above.
    choose(document.querySelector('.review-worktree'), `${parent}/feature`)
    await until('clean merge verified', () =>
      text(sid).includes(`merge-verified:${parent}/integration`),
    )
    assert(text(sid).includes(findingsFile), 'merge briefing did not name the findings file')
    assert(text(sid).includes('merge-result:clean'), 'clean destination did not merge cleanly')
    assert(
      state().sessionRecords.filter((r) => r.metadata.componentId === '@merge').length === 1,
      'duplicate submit launched twice',
    )
    assert(
      document.querySelector('.review-worktree').value === `${parent}/feature`,
      'launch switched the reviewed source',
    )
    form = await openDialog()
    choose(form.querySelector('select[aria-label="Destination worktree"]'), `${parent}/integration`)
    await until(
      'running destination blocked',
      () => dialog().querySelector('button[type="submit"]').disabled,
    )
    click([...form.querySelectorAll('button')].find((b) => b.textContent === 'Cancel'))
    state().setView('navigation')
    await until('left Review', () => !document.querySelector('.review-view'))
    state().setView('review')
    await until(
      'recovered merge terminal',
      () => document.querySelector('.review-merge-terminal')?.dataset.session === sid,
    )
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find((b) =>
        b.textContent.includes('Stop'),
      ),
    )
    await until('merge stopped', () => state().sessions[sid]?.running === false)
    state().setView('navigation')
    await until('Navigation mounted after stopping merge', () =>
      document.querySelector('.terminal-dock'),
    )
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
      document.querySelector('.review-worktree'),
    )
    // Review's worktree picker is local to each mount; restore the source after remounting.
    choose(document.querySelector('.review-worktree'), `${parent}/feature`)
    await until('source restored', () =>
      document.querySelector('.review-banner')?.textContent.includes('feature'),
    )
    await smoke.terminalWrite(
      shell,
      `git -C '${parent}/integration' branch -m refreshed-integration; printf "BRANCH-RENAMED\\n"\r`,
    )
    await until('terminal branch rename', () => text(shell).includes('\nBRANCH-RENAMED\n'))
    await until('worktree poll updates destination branch', () =>
      [...document.querySelectorAll('.review-worktree option')].some((o) =>
        o.textContent.includes('refreshed-integration'),
      ),
    )
    await smoke.terminalWrite(
      shell,
      `git -C '${parent}/integration' branch -m integration; printf "BRANCH-RESTORED\\n"\r`,
    )
    await until('terminal branch restored', () => text(shell).includes('\nBRANCH-RESTORED\n'))
    window.dispatchEvent(new Event('focus'))
    await until('focus updates destination branch', () =>
      [...document.querySelectorAll('.review-worktree option')].some((o) =>
        o.textContent.startsWith('integration ·'),
      ),
    )
    form = await openDialog()
    choose(form.querySelector('select[aria-label="Destination worktree"]'), `${parent}/integration`)
    await until(
      'stopped destination available again',
      () => !dialog().querySelector('button[type="submit"]').disabled,
    )
    // A clean but still-running terminal must not share the merge destination.
    await smoke.terminalStop(shell)
    await until('destination shell stopped', () => state().sessions[shell]?.running === false)
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Hide',
      ),
    )
    // Forgetting the hidden merge must not collapse the next merge, even before selection.
    await smoke.sessionForget(sid)
    await smoke.reconcileSessions()
    choose(form.querySelector('select[aria-label="Destination worktree"]'), opened.project.root)
    submit()
    await until('conflict destination terminal', () => {
      const el = document.querySelector('.review-merge-terminal')
      return el?.dataset.session !== sid && el
    })
    sid = document.querySelector('.review-merge-terminal').dataset.session
    await until('conflict merge verified', () =>
      text(sid).includes(`merge-verified:${opened.project.root}`),
    )
    assert(
      text(sid).includes('merge-result:resolved-conflict'),
      'conflicting destination was not resolved',
    )
    assert(
      document.querySelector('.review-merge-terminal .terminal-area').getBoundingClientRect()
        .height > 60,
      'merge terminal has no usable height',
    )
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find((b) =>
        b.textContent.includes('Stop'),
      ),
    )
    await until('second merge stopped', () => state().sessions[sid]?.running === false)
    click(
      [...document.querySelectorAll('.review-merge-terminal button')].find(
        (b) => b.textContent === 'Hide',
      ),
    )
    await until('finished merge hidden', () => !document.querySelector('.review-merge-terminal'))
    state().setView('navigation')
    await until('left finished merge Review', () => !document.querySelector('.review-view'))
    state().setView('review')
    await until('finished merge Review remounted', () => document.querySelector('.review-view'))
    assert(
      !document.querySelector('.review-merge-terminal'),
      'finished hidden merge reopened on remount',
    )
    smoke.store.setState({ sessionsPanelOpen: true })
    // Only once it has ended: a running row has neither Show in Review nor (without an
    // adapter) a menu.
    const mergeRow = await until('finished destination session row', () =>
      [...document.querySelectorAll('.session-row')].find((r) => {
        const scope = r.querySelector('small')?.textContent ?? ''
        const state = r.querySelector(':scope > span')?.textContent
        return (
          scope.startsWith('@merge') &&
          scope.endsWith(opened.project.root) &&
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
      () =>
        document.querySelector('.review-merge-terminal')?.dataset.session === sid &&
        mergeHeight() > 100,
    )
    assert(!state().dockKept.includes(sid), 'finished merge was retained in the dock')
    await smoke.terminalStop(shell)
    await smoke.report(
      'PASS merge: review findings/read-only fixture/staleness/recovery and Fix in Implementation handoff, dirty destination errors, defaults, clean/conflict merges, duplicate prevention, panel sizing/Hide persistence, Sessions/Attention reveal, branch polling/focus refresh, Navigation exclusion, Review terminal recovery and Stop',
    )
  } catch (e) {
    await smoke.report(`FAIL merge: ${e?.message ?? e}`)
  }
})()
