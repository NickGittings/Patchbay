// Drive native editor IPC, actual xterm selection/link activation, and quick search.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check, timeout = 12000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const path = "target file ; $() ' {line}.txt"
  let previous
  let sid
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  try {
    const opened = await smoke.openProject()
    assert(opened, 'project not opened')
    smoke.acceptOpened(opened)
    await smoke.syncCurrentRoots()
    const projectId = state().project.id
    const files = await smoke.fileSearch('', projectId, null)
    assert(
      files.some((f) => f.path === 'tracked.log'),
      'tracked ignored file omitted',
    )
    assert(!files.some((f) => f.path === 'ignored.log'), 'untracked ignored file exposed')
    assert(!files.some((f) => f.path === 'escape.txt'), 'symlink escape exposed')
    assert(
      (await smoke.fileSearch('target', projectId, null))[0]?.path === path,
      'filename ranking',
    )
    previous = await smoke.editorPreferences()
    await smoke.editorSavePreferences({
      editor: 'custom',
      executable: `${opened.project.root}/editor launcher`,
      arguments: ['{file}', '--line={line}', '--column={column}'],
    })
    await smoke.editorOpen({ path, line: 17, column: 5 }, projectId, null)
    sid = smoke.sessionId('navigation', 'shell')
    await smoke.startTerminal('navigation', 'shell')
    await until('running shell', () => state().sessions[sid]?.running)
    state().select('navigation')
    state().setActiveSession(sid)
    await sleep(400)
    await smoke.terminalWrite(sid, 'cat editor.log\r')
    await until('literal editor argument', () =>
      smoke
        .terminalText(sid)
        .text.replace(/\s+/g, '')
        .includes(`EDITOR_ARG:<${opened.project.root}/${path}>`.replace(/\s+/g, '')),
    )
    assert(smoke.terminalText(sid).text.includes('EDITOR_ARG:<--line=17>'), 'line argument lost')
    assert(smoke.terminalText(sid).text.includes('EDITOR_ARG:<--column=5>'), 'column argument lost')
    try {
      await smoke.editorOpen({ path: 'escape.txt' }, projectId, null)
      throw new Error('native editor accepted symlink escape')
    } catch (e) {
      assert(String(e).includes('outside the project'), String(e))
    }
    const generation = smoke.sessionGeneration(sid)
    try {
      await smoke.terminalOpenReference(sid, generation - 1, 'tracked.log:1')
      throw new Error('old generation accepted')
    } catch (e) {
      assert(String(e).includes('earlier process'), String(e))
    }
    try {
      await smoke.terminalOpenReference(sid, generation, 'missing/tracked.log:1')
      throw new Error('unresolved location accepted')
    } catch (e) {
      assert(String(e).includes('recorded launch folder'), String(e))
    }
    await smoke.terminalWrite(sid, 'printf "tracked.log:2:3\\n"\r')
    const point = await until('visible terminal location', () =>
      smoke.terminalNavigationState(sid, 'tracked.log:2:3'),
    )
    const screen = document.elementFromPoint(point.x, point.y)
    assert(screen, 'terminal not visible')
    const mouse = (target, type, x, opts = {}) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          clientX: x,
          clientY: point.y,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          detail: 1,
          ...opts,
        }),
      )
    mouse(screen, 'mousemove', point.x)
    await sleep(100)
    mouse(screen, 'mousedown', point.x)
    mouse(document, 'mousemove', point.x + point.width * 7)
    mouse(document, 'mouseup', point.x + point.width * 7)
    assert(
      smoke.terminalNavigationState(sid, 'tracked.log:2:3')?.selection,
      'normal drag did not select terminal text',
    )
    // A plain click clears the selection and must not open a link.
    mouse(screen, 'mousemove', point.x)
    mouse(screen, 'mousedown', point.x)
    mouse(screen, 'mouseup', point.x)
    await sleep(100)
    mouse(screen, 'mousemove', point.x)
    mouse(screen, 'mousedown', point.x, { ctrlKey: true })
    mouse(screen, 'mouseup', point.x, { ctrlKey: true })
    await sleep(300)
    await smoke.terminalWrite(sid, 'cat editor.log\r')
    await until('modifier link action', () =>
      smoke.terminalText(sid).text.includes('EDITOR_ARG:<--line=2>'),
    )
    const displayedGeneration = smoke.terminalNavigationState(sid, 'tracked.log:2:3')?.generation
    assert(displayedGeneration === generation, 'terminal location lost its output generation')
    smoke.stopTerminal(sid)
    await until('first generation stopped', () => !state().sessions[sid]?.running)
    await smoke.startTerminal('navigation', 'shell')
    await until('second generation started', () => smoke.sessionGeneration(sid) > generation)
    assert(
      smoke.terminalNavigationState(sid, 'tracked.log:2:3')?.generation === generation,
      'history location rebound to newer process',
    )
    const wrapped = `e\u0301${'x'.repeat(150)}.rs:8:9`
    await smoke.terminalWrite(sid, `printf 'prefix 🧭 ${wrapped}\\n'\r`)
    await until('Unicode soft-wrapped location', () => smoke.terminalNavigationState(sid, wrapped))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
    const input = await until('file search shortcut', () =>
      document.querySelector('[aria-label="Quick file search"] input'),
    )
    await until('ranked path list', () =>
      document.querySelector('[aria-label="Files"] [role="option"]'),
    )
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const task = await smoke.createTask({
      title: 'Navigation task',
      branch: 'navigation-smoke-task',
      components: ['navigation'],
    })
    const taskFiles = await smoke.fileSearch('', projectId, task.id)
    assert(
      taskFiles.some((f) => f.path === path),
      'task tracked target omitted',
    )
    assert(
      !taskFiles.some((f) => f.path === 'root-only.txt'),
      'task search leaked original worktree',
    )
    await smoke.editorOpen({ path, line: 21 }, projectId, task.id)
    await smoke.editorOpen({ path, line: 22 }, projectId, null, task.worktree)
    state().setActiveTask(null)
    state().setActiveSession(sid)
    await sleep(300)
    await smoke.terminalWrite(sid, 'cat editor.log\r')
    await until('task and explicit review editor target', () => {
      const text = smoke.terminalText(sid).text.replace(/\s+/g, '')
      return (
        text.includes(`EDITOR_ARG:<${task.worktree}/${path}>`.replace(/\s+/g, '')) &&
        text.includes('EDITOR_ARG:<--line=21>') &&
        text.includes('EDITOR_ARG:<--line=22>')
      )
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
    await until('original worktree search', () =>
      [...document.querySelectorAll('[aria-label="Files"] [role="option"]')].some((b) =>
        b.textContent.includes('root-only.txt'),
      ),
    )
    state().setActiveTask(task.id)
    await until('task search discards stale original files', () => {
      const dialog = document.querySelector('[aria-label="Quick file search"]')
      return (
        dialog &&
        !dialog.textContent.includes('Searching…') &&
        !dialog.textContent.includes('root-only.txt')
      )
    })
    state().setActiveTask(null)
    document
      .querySelector('[aria-label="Quick file search"] input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await smoke.editorSavePreferences({
      editor: 'custom',
      executable: '/missing/patchbay-editor',
      arguments: ['{file}'],
    })
    const openButton = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Open in editor',
    )
    assert(openButton, 'component editor action missing')
    openButton.click()
    await until('missing editor explanation', () =>
      document
        .querySelector('[aria-label="Preferred editor"]')
        ?.textContent.includes('Editor unavailable:'),
    )
    await smoke.editorSavePreferences(previous)
    smoke.resetSessions(await smoke.terminalReset())
    await smoke.report(
      'PASS navigation: safe argv, ignored/tracked files, denied symlink, generation/cwd checks, selection and modifier links, file search and editor setup',
    )
  } catch (e) {
    if (previous) await smoke.editorSavePreferences(previous).catch(() => {})
    if (sid) smoke.stopTerminal(sid)
    await smoke.report(`FAIL navigation: ${String(e)} ${e?.stack || ''}`)
  }
})()
