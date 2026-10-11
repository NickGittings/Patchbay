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
    await until('merge terminal', () => document.querySelector('.review-merge-terminal'))
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
    assert(
      state().panels['ReviewView-merge']['ReviewView-merge-terminal'] === 0,
      'hidden merge panel was removed from saved layout',
    )
    // Hide survives view changes, and an explicit reveal works even when already active.
    state().setView('navigation')
    await until('left hidden Review', () => !document.querySelector('.review-view'))
    state().setView('review')
    await until('hidden Review restored', () => document.querySelector('.review-view'))
    assert(!document.querySelector('.review-merge-terminal'), 'hidden merge reopened on remount')
    click(
      [...document.querySelectorAll('.review-view button')].find(
        (b) => b.textContent === 'Show merge',
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
      await until('attention toolbar button', () => document.querySelector('.attention-button')),
    )
    click(
      await until('merge attention entry', () =>
        [...document.querySelectorAll('.attention-item')].find((b) =>
          b.textContent.includes('Merge agent'),
        ),
      ),
    )
    await until('attention reveals the already active merge', () => mergeHeight() > 100)
    assert(!state().dockKept.includes(sid), 'merge was retained in the Navigation dock')
    state().setSession(sid, priorSession)
    // The picker is local to Review; restore it after the remount above.
    choose(document.querySelector('.review-worktree'), `${parent}/feature`)
    await until('clean merge verified', () =>
      text(sid).includes(`merge-verified:${parent}/integration`),
    )
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
    const reviewMerge = await until('Review merge action for finished destination', () => {
      const row = [...document.querySelectorAll('.session-row')].find((r) => {
        const scope = r.querySelector('small')?.textContent ?? ''
        return scope.startsWith('@merge') && scope.endsWith(opened.project.root)
      })
      return [...(row?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'Review merge',
      )
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
      'PASS merge: dirty destination errors, defaults, clean/conflict merges, duplicate prevention, panel sizing/Hide persistence, Sessions/Attention reveal, branch polling/focus refresh, Navigation exclusion, Review terminal recovery and Stop',
    )
  } catch (e) {
    await smoke.report(`FAIL merge: ${e?.message ?? e}`)
  }
})()
