// Pop-out window smoke test. `npm run smoke` evaluates this in every window via the
// debug-only hook in src-tauri/src/smoke.rs; the app exits 0 on PASS and 1 on FAIL.
//
// Main window: open the repo, start a shell, print a marker, pop the component out.
// Pop-out: check the marker was replayed from the backlog, live input works, and the
// file tree and terminal tiles render.
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
      await smoke.openComponentWindow(node.id, node.data.name)
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
    await smoke.report(`PASS ${node.data.name}: backlog replayed, live input, file tree, tiles`)
  } catch (e) {
    await smoke.report(`FAIL ${popout ?? 'main'}: ${e?.message ?? e}`)
  }
})()
