// Exercise the watcher with a shell that stays running throughout file edits.
// No focus or terminal-exit signal can mask a broken filesystem trigger.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const id = 'git-smoke'
  const sid = `${id}/shell`
  const scratch = `.patchbay-smoke-git-${Date.now()}`
  let started = false
  let originalSetStatus
  try {
    const opened = await smoke.openProject()
    if (!opened) throw new Error('project was not opened')
    state().loadProject({
      ...opened.project,
      components: [
        {
          id,
          name: 'Git smoke',
          kind: 'other',
          path: '.',
          notes: '',
          position: { x: 0, y: 0 },
          terminals: [{ id: 'shell', name: 'Shell', command: '', kind: 'shell' }],
        },
      ],
      links: [],
    })
    await smoke.syncCurrentRoots()
    await smoke.startTerminal(id, 'shell')
    started = true
    await until('shell running', () => state().sessions[sid]?.running)
    await sleep(1500)
    await smoke.requestGitRefresh()
    const baseline = state().gitChanges[id]
    if (typeof baseline !== 'number') throw new Error('root is not a Git repository')
    originalSetStatus = state().setGitStatus
    let refreshes = 0
    smoke.store.setState({
      setGitStatus: (status) => {
        refreshes++
        originalSetStatus(status)
      },
    })
    const write = (command) => smoke.terminalWrite(sid, `${command}\r`)
    await write(`printf scratch > '${scratch}'`)
    await until('new file badge', () => state().gitChanges[id] === baseline + 1)
    await write(`rm '${scratch}'`)
    await until('removed file badge', () => state().gitChanges[id] === baseline)
    // Flush any already-debounced batch, then wait beyond the former poll interval.
    await sleep(2500)
    const beforeIdle = refreshes
    await sleep(6000)
    if (refreshes !== beforeIdle) throw new Error('Git refreshes while idle')
    if (!state().sessions[sid]?.running) throw new Error('shell exited during watcher checks')
    smoke.store.setState({ setGitStatus: originalSetStatus })
    smoke.resetSessions(await smoke.terminalReset())
    await smoke.report(
      'PASS git: live file creation/deletion, idle without polling or self-trigger',
    )
  } catch (e) {
    if (originalSetStatus) smoke.store.setState({ setGitStatus: originalSetStatus })
    if (started) {
      await smoke.terminalWrite(sid, `rm -f '${scratch}'\r`).catch(() => {})
      await sleep(300)
      smoke.resetSessions(await smoke.terminalReset())
    }
    await smoke.report(`FAIL git: ${e?.message ?? e}`)
  }
})()
