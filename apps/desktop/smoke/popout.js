// Pop-out window smoke test. `npm run smoke` evaluates this in every window via the
// debug-only hook in src-tauri/src/smoke.rs; the app exits 0 on PASS and 1 on FAIL.
//
// Main window: open the repo, start a shell, print a marker, pop the component out.
// Pop-out: check the marker was replayed from the backlog, live input works, and the
// file tree, terminal tiles and Changes tab render.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(100)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const popout = new URLSearchParams(location.search).get('component')
  const shellOf = (node) => node.data.terminals.find((t) => t.kind === 'shell')
  const textOf = (sid) => smoke.terminalText(sid).text

  try {
    if (popout === null) {
      const { project } = await smoke.openProject()
      smoke.store.getState().loadProject(project)
      const node = smoke.store.getState().nodes.find(shellOf)
      if (!node) throw new Error('no component with a shell terminal')
      const shell = shellOf(node)
      const sid = smoke.sessionId(node.id, shell.id)
      await smoke.startTerminal(node.id, shell.id)
      await until('shell to start', () => smoke.store.getState().sessions[sid]?.running)
      // Arithmetic so the typed command never matches the expected output.
      await smoke.terminalWrite(sid, 'echo backlog-$((40+2))\r')
      await until('marker output', () => textOf(sid).includes('backlog-42'))
      const state = smoke.store.getState()
      state.clearHighlights()
      state.select(node.id)
      state.setView('implementation')
      await until('implementation tile', () =>
        document.querySelector(
          `.implementation-view [data-component="${node.id}"] button[aria-label^="Maximize"]`,
        ),
      )
      document
        .querySelector(
          `.implementation-view [data-component="${node.id}"] button[aria-label^="Maximize"]`,
        )
        .click()
      await until('maximized tile', () =>
        document.querySelector('.implementation-view .terminal-tile.maximized'),
      )
      const button = document.querySelector('.implementation-view .group-popout')
      if (!button || button.getBoundingClientRect().width === 0)
        throw new Error('maximizing the only component hides its pop-out button')
      button.click()
      return
    }

    const node = await until('project sync', () =>
      smoke.store.getState().nodes.find((n) => n.id === popout),
    )
    const sid = smoke.sessionId(popout, shellOf(node).id)
    await until('replayed backlog', () => textOf(sid).includes('backlog-42'))
    await smoke.terminalWrite(sid, 'echo live-$((1+1))\r')
    await until('live output', () => textOf(sid).includes('live-2'))
    await until('file tree entries', () => document.querySelector('.file-tree-entry'))
    await until(
      'terminal tiles',
      () => document.querySelectorAll('.terminal-tile').length === node.data.terminals.length,
    )
    const changesTab = Array.from(document.querySelectorAll('.side-tabs [role="tab"]')).find(
      (button) => button.textContent.startsWith('Changes'),
    )
    if (!changesTab) throw new Error('missing Changes tab')
    changesTab.click()
    await until('component changes', () => {
      const panel = document.querySelector('.component-window .changes-panel')
      if (!panel) return false
      const error = panel.querySelector('.file-tree-error, .diff-error')
      if (error) throw new Error(error.textContent)
      return panel.querySelector('.change-list') || panel.querySelector('.empty-state')
    })
    if (document.querySelector('.changes-panel .change-list')) {
      await until('component diff', () => {
        const error = document.querySelector('.changes-panel .diff-error')
        if (error) throw new Error(error.textContent)
        const diff = document.querySelector('.changes-panel .diff-view')
        return diff && !diff.classList.contains('diff-loading')
      })
    } else {
      const title = document.querySelector('.changes-panel .empty-state-title')?.textContent
      if (title !== `No changes in ${node.data.name}`)
        throw new Error(`incorrect component changes empty state: ${title}`)
    }
    if (!document.querySelector('.component-window .terminal-tile'))
      throw new Error('Changes tab hides the terminals')
    await smoke.report(
      `PASS ${node.data.name}: maximized pop-out, backlog replayed, live input, file tree, tiles, changes`,
    )
  } catch (e) {
    await smoke.report(`FAIL ${popout ?? 'main'}: ${e?.message ?? e}`)
  }
})()
