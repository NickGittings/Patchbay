// Presentation checks deliberately avoid planner/terminal lifecycle dependencies.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const query = (selector) => document.querySelector(selector)
  const click = (element) => element.click()
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const changesSettled = (selector) => {
    const element = query(selector)
    return (
      element &&
      (element.querySelector('.change-list') ||
        element.textContent.includes('No uncommitted changes'))
    )
  }
  try {
    const opened = await smoke.openProject()
    assert(opened, 'project not opened')
    smoke.acceptOpened(opened)
    await smoke.syncCurrentRoots()
    const originalSize = [window.innerWidth, window.innerHeight]
    await smoke.resizeWindow(1440, 900)
    await until('wide window', () => window.innerWidth >= 1100)
    const rail = document.querySelector('.workspace-rail')
    const toggleLabels = () => rail.querySelector('[aria-label$="navigation labels"]')
    if (window.innerWidth >= 1100) {
      assert(rail.dataset.expanded === 'false', 'rail should start compact')
      const originalView = state().view
      toggleLabels().click()
      await until('expanded rail', () => rail.dataset.expanded === 'true')
      assert(localStorage.getItem('patchbay.railExpanded') === 'true', 'rail preference not saved')
      assert(Math.round(rail.getBoundingClientRect().width) === 168, 'expanded rail width')
      assert(state().view === originalView, 'expansion changed selected view')
      assert(rail.querySelector('.rail-group-label').getClientRects().length, 'group labels hidden')
      await smoke.resizeWindow(900, 900)
      await until('automatic compact rail', () => rail.dataset.expanded === 'false')
      assert(
        localStorage.getItem('patchbay.railExpanded') === 'true',
        'narrow window lost preference',
      )
      await smoke.resizeWindow(1440, 900)
      await until('labels restored', () => rail.dataset.expanded === 'true')
      rail.querySelector('button[aria-label="Sessions"]').click()
      const resize = await until('utility resize handle', () =>
        document.querySelector('.utility-resize'),
      )
      const widthBefore = Number(resize.getAttribute('aria-valuenow'))
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await until(
        'expanded rail utility resized',
        () => Number(resize.getAttribute('aria-valuenow')) === widthBefore + 20,
      )
      assert(
        document.querySelector('.utility-panel').getBoundingClientRect().left >=
          rail.getBoundingClientRect().right,
        'panel overlaps expanded rail',
      )
      rail.querySelector('button[aria-label="Sessions"]').click()
      toggleLabels().click()
      await until('compact rail', () => rail.dataset.expanded === 'false')
    }
    const railView = rail.querySelector('button[aria-label="Navigation"]')
    railView.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    assert(!document.querySelector('.rail-tooltip'), 'pointer tooltip opened without delay')
    await until('delayed tooltip', () => document.querySelector('.rail-tooltip'))
    railView.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    await until('tooltip dismissed', () => !document.querySelector('.rail-tooltip'))

    railView.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(400)
    assert(!document.querySelector('.rail-tooltip'), 'Escape did not cancel pending tooltip')
    railView.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    await smoke.resizeWindow(...originalSize)
    state().setView('review')
    await until('review list', () => changesSettled('.review-view'))
    assert(query('.review-context code'), 'review branch context missing')
    const locationDetails = query('.review-context details')
    assert(locationDetails && !locationDetails.open, 'worktree path should start collapsed')
    assert(query('.review-agent-button.primary'), 'review action lacks primary treatment')
    assert(!query('.review-merge-button.primary'), 'merge action should be secondary')
    const reviewFetch = window.fetch
    const reviewUrl = window.__TAURI_INTERNALS__.convertFileSrc('git_review', 'ipc')
    window.fetch = (input, options) =>
      String(input) === reviewUrl
        ? Promise.resolve(
            new Response('Smoke: review unavailable', {
              headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' },
            }),
          )
        : reviewFetch(input, options)
    try {
      click(query('.review-refresh'))
      const failure = await until('review failure feedback', () =>
        query('.review-list .panel-status[data-kind="error"]'),
      )
      assert(failure.querySelector('[role="alert"]'), 'failure not announced')
      assert(!failure.querySelector('details').open, 'raw error details should start collapsed')
      assert(
        document.querySelectorAll('.review-view .panel-status[data-kind="error"]').length === 1,
        'duplicated review error',
      )
    } finally {
      window.fetch = reviewFetch
    }
    click(query('.review-list .panel-status button'))
    await until(
      'review retry recovered',
      () =>
        !query('.review-list .panel-status[data-kind="error"]') && changesSettled('.review-view'),
    )

    await smoke.report(
      'PASS design: rail labels, preference, width threshold, panel resize, tooltip timing and Escape, review summary and retry recovery',
    )
  } catch (error) {
    await smoke.report(`FAIL design: ${String(error)} ${error?.stack || ''}`)
  }
})()
