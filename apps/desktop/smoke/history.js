// Real Tauri IPC and rendered history in both Changes surfaces.
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
    const checkHistory = async (scope) => {
      const root = await until(scope, () => document.querySelector(scope))
      const toggle = await until('history header', () =>
        root.querySelector('.commit-history header button'),
      )
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click()
      const row = await until('commit row', () => root.querySelector('.commit-row'))
      row.click()
      await until('historical files', () => root.querySelector('.commit-files button'))
      await until('historical diff', () => root.querySelector('.commit-details .diff'))
      if (root.querySelector('.diff-error'))
        throw new Error(root.querySelector('.diff-error').textContent)
      const second = root.querySelectorAll('.commit-files button')[1]
      if (second) {
        second.click()
        await until('second historical file selected', () => second.classList.contains('active'))
      }
      const file = root.querySelector('.change-row')
      if (file) {
        file.click()
        await until('working changes restored', () => !root.querySelector('.commit-details'))
      }
      toggle.click()
      await until('graph collapsed', () => !root.querySelector('.commit-row'))
    }
    await checkHistory('.review-view')
    state().setSimpleMode(true)
    await until('chat', () => document.querySelector('.simple-chat'))
    smoke.simpleUi
      .getState()
      .patch(smoke.simpleKey(state().project.id, state().activeTask), { changes: true })
    await checkHistory('.simple-diff')
    await smoke.report(
      'PASS history: Review and chat graph, historical files/diffs, collapse, and return to working changes',
    )
  } catch (e) {
    await smoke.report('FAIL history: ' + (e?.message ?? e))
  }
})()
