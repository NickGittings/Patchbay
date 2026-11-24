// Real Tauri IPC and the Git panel's history, opening in both Changes surfaces.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (label, check) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Timed out: ' + label)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    smoke.acceptOpened(await smoke.openProject())
    await smoke.syncCurrentRoots()
    state().setSimpleMode(false)
    state().setView('review')
    // History lives in the rail's Git panel; a chosen commit opens in the view's diff pane.
    const gitPanel = async () => {
      if (!document.querySelector('.utility-panel[data-panel="git"]'))
        (
          await until('Git rail button', () =>
            document.querySelector('.workspace-rail [aria-label="Git"]'),
          )
        ).click()
      return until('Git panel', () => document.querySelector('.utility-panel[data-panel="git"]'))
    }
    const checkHistory = async (scope) => {
      const view = await until(scope, () => document.querySelector(scope))
      const panel = await gitPanel()
      await until('sync status', () => panel.querySelector('.git-sync-counts'))
      const toggle = await until('history header', () =>
        panel.querySelector('.commit-history header button'),
      )
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
      const row = await until('commit row', () => panel.querySelector('.commit-row'))
      row.click()
      await until('historical files', () => panel.querySelector('.commit-files button'))
      await until('historical diff', () => view.querySelector('.commit-details .diff'))
      if (view.querySelector('.diff-error'))
        throw new Error(view.querySelector('.diff-error').textContent)
      const second = panel.querySelectorAll('.commit-files button')[1]
      if (second) {
        second.click()
        await until('second historical file selected', () => second.classList.contains('active'))
      }
      const file = view.querySelector('.change-row')
      if (file) {
        file.click()
        await until('working changes restored', () => !view.querySelector('.commit-details'))
      }
      toggle.click()
      await until('graph collapsed', () => !panel.querySelector('.commit-row'))
      // The open state persists across launches; leave it as other smoke scripts expect.
      toggle.click()
      await until('graph reopened', () => panel.querySelector('.commit-row'))
    }
    await checkHistory('.review-view')
    state().setSimpleMode(true)
    await until('chat', () => document.querySelector('.simple-chat'))
    smoke.simpleUi
      .getState()
      .patch(smoke.simpleKey(state().project.id, state().activeTask), { changes: true })
    await checkHistory('.simple-diff')
    await smoke.report(
      'PASS history: Git panel graph opening in Review and chat, historical files/diffs, collapse, and return to working changes',
    )
  } catch (e) {
    await smoke.report('FAIL history: ' + (e?.message ?? e))
  }
})()
