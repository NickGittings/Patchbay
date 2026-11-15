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
    await smoke.editorSavePreferences({ ...previous, fileOpenMode: 'patchbay' })
    const scope = { projectId, task: null }
    const originalText = (await smoke.readTextFile(scope, path)).text
    state().select('navigation')
    // Inspector controls run real sessions without opening their configuration.
    const inspector = await until('component inspector', () => document.querySelector('.inspector'))
    const disclosure = () =>
      [...inspector.querySelectorAll('.inspector-terminal-disclosure')].at(-1)
    const settings = () => [...inspector.querySelectorAll('.inspector-terminal-settings')].at(-1)
    const summary = (title) =>
      [...inspector.querySelectorAll('summary')].find((s) => s.textContent === title)
    assert(disclosure()?.getAttribute('aria-expanded') === 'false', 'terminal settings start open')
    assert(!summary('Component settings').parentElement.open, 'component settings start open')
    assert(!summary('Details').parentElement.open, 'details start open')
    assert(!disclosure().querySelector('button'), 'terminal action nested in disclosure')
    const scratchId = state().addTerminal(
      'navigation',
      {
        id: 'inspector-shell',
        name: 'Inspector shell',
        kind: 'shell',
        command: '',
      },
      false,
    )
    await until('scratch terminal', () =>
      inspector.querySelector('[aria-label="Start Inspector shell"]'),
    )
    inspector.querySelector('[aria-label="Start Inspector shell"]').click()
    const inspectorSid = smoke.sessionId('navigation', scratchId)
    await until('inspector starts shell', () => state().sessions[inspectorSid]?.running)
    assert(disclosure().getAttribute('aria-expanded') === 'false', 'Start opened settings')
    disclosure().click()
    await until('terminal settings expanded', () => !settings().hidden)
    assert(settings().querySelector('button').disabled, 'running terminal can be removed')
    inspector.querySelector('[aria-label="Stop Inspector shell"]').click()
    await until('inspector stops shell', () => !state().sessions[inspectorSid]?.running)
    await until('stopped terminal removable', () => !settings().querySelector('button').disabled)
    const setInput = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setInput(settings().querySelector('input'), 'Renamed shell')
    await until(
      'terminal name saved',
      () =>
        state().nodes[0].data.terminals.find((t) => t.id === scratchId)?.name === 'Renamed shell',
    )
    settings().querySelector('button').click()
    await until(
      'terminal removed',
      () => !state().nodes[0].data.terminals.some((t) => t.id === scratchId),
    )
    disclosure().click()
    summary('Component settings').click()
    summary('Details').click()
    state().select(null)
    smoke.store.setState({ inspector: true })
    await until('project overview', () => inspector.textContent.includes('Project overview'))
    state().select('navigation')
    await until('component reselected', () => disclosure())
    assert(
      disclosure().getAttribute('aria-expanded') === 'false',
      'terminal disclosure leaked across selection',
    )
    assert(
      !summary('Component settings').parentElement.open,
      'component disclosure leaked across selection',
    )
    assert(!summary('Details').parentElement.open, 'details disclosure leaked across selection')
    assert(
      inspector.querySelector('.inspector-path').title === opened.project.root,
      'header lost full path',
    )

    // Finish terminal teardown before testing focus: a late dock mount can focus xterm.
    smoke.resetSessions(await smoke.terminalReset())
    await until('terminal dock cleared', () => !document.querySelector('.terminal-dock .xterm'))
    const trigger = inspector.querySelector('[aria-label="Component actions"]')
    const menu = () => document.querySelector('[role="menu"][aria-label="Component actions"]')
    const menuKey = (target, key) =>
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    trigger.focus()
    menuKey(trigger, 'ArrowDown')
    await until('keyboard component menu', menu)
    assert(
      document.activeElement === menu().querySelector('[role="menuitem"]'),
      'menu did not focus first action',
    )
    menuKey(document.activeElement, 'ArrowDown')
    assert(document.activeElement.textContent === 'Open in window', 'menu arrow navigation failed')
    menuKey(document.activeElement, 'Escape')
    await until('menu dismissed with Escape', () => !menu())
    assert(document.activeElement === trigger, 'Escape did not restore trigger focus')
    await sleep(100)
    const header = inspector.querySelector('.inspector-header')
    const bounds = header.getBoundingClientRect()
    const at = { x: bounds.left + 24, y: bounds.bottom - 4 }
    const openContextMenu = async () => {
      header.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: at.x,
          clientY: at.y,
        }),
      )
      await until('header context menu positioned at pointer', () => {
        const rect = menu()?.getBoundingClientRect()
        return rect && Math.abs(rect.left - at.x) < 2 && Math.abs(rect.top - at.y) < 2
      })
    }
    await openContextMenu()
    assert(menu().textContent.includes('Validate affected'), 'context menu missing validation')
    menuKey(menu(), 'ArrowDown')
    menuKey(document.activeElement, 'Escape')
    await until('context menu dismissed with Escape', () => !menu())
    assert(document.activeElement === trigger, 'context menu did not restore focus')
    await openContextMenu()
    menuKey(menu(), 'ArrowDown')
    menuKey(document.activeElement, 'Tab')
    await until('context menu dismissed with Tab', () => !menu())
    // Let WebKit finish the Tab focus change before the next interaction.
    await sleep(50)
    trigger.click()
    await until('ellipsis reopens after context menu', menu)
    assert(menu().textContent.includes('Open in window'), 'ellipsis menu lost actions')
    inspector
      .querySelector('.inspector-toolbar button')
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await until('outside press dismisses menu', () => !menu())
    const filesTab = await until('Inspector Files tab', () =>
      [...document.querySelectorAll('.inspector .tabs button')].find(
        (button) => button.textContent.trim() === 'Files',
      ),
    )
    filesTab.click()
    const fileItem = (name) =>
      [...document.querySelectorAll('.inspector [role="treeitem"]')].find(
        (row) => row.title === name,
      )
    const targetRow = await until('target file row', () => fileItem(path))
    assert(
      !targetRow.closest('.file-tree-row').querySelector('[title="Open in editor"]'),
      'redundant file editor button remains',
    )
    targetRow.click()
    const editor = await until('built-in editor', () =>
      document.querySelector('.file-editor textarea'),
    )
    assert(!editor.closest('[role="dialog"]'), 'file editor opened in a popup')
    await until('Component Panel and editor to the left of the graph', () => {
      const panel = document.querySelector('.inspector').getBoundingClientRect()
      const graph = document.querySelector('.navigation-map').getBoundingClientRect()
      const file = document.querySelector('.file-editor').getBoundingClientRect()
      return (
        panel.width > 0 && file.width > 0 && panel.right <= file.left && file.right <= graph.left
      )
    })
    assert(document.querySelector('.react-flow__attribution'), 'React Flow attribution missing')
    await smoke.openInEditor({ path, line: 2 }, scope)
    assert(
      document.querySelectorAll('.file-editor [role="tab"]').length === 1,
      'duplicate editor tab',
    )
    const edit = (text) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(editor, text)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const action = (label) =>
      [...document.querySelectorAll('.file-editor button')].find(
        (button) => button.textContent.trim() === label,
      )
    edit('saved from Patchbay\n')
    await until('dirty editor', () => action('Save') && !action('Save').disabled)
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
    await until(
      'saved file',
      async () => (await smoke.readTextFile(scope, path)).text === 'saved from Patchbay\n',
    )
    await until('save completed', () => !action('Reload').disabled)
    edit('unsaved draft')
    document.querySelector('button[aria-label="Close File editor"]').click()
    await until('unsaved prompt', () => document.querySelector('[role="alertdialog"]'))
    action('Cancel').click()
    await until('cancel keeps editor', () => !document.querySelector('[role="alertdialog"]'))
    assert(editor.value === 'unsaved draft', 'cancel lost the draft')
    edit(originalText)
    await until('restore enabled', () => !action('Save').disabled)
    action('Save').click()
    await until(
      'original restored',
      async () => (await smoke.readTextFile(scope, path)).text === originalText,
    )
    await until('restore completed', () => !action('Reload').disabled)
    document.querySelector('button[aria-label="Close File editor"]').click()
    await until('editor closed', () => !document.querySelector('.file-editor'))
    targetRow.click()
    await until('editor reopened with one click', () =>
      document.querySelector('.file-editor textarea'),
    )
    fileItem('tracked.log').click()
    await until(
      'second file tab',
      () =>
        document.querySelectorAll('.file-editor [role="tab"]').length === 2 &&
        document.querySelector('.file-editor [aria-selected="true"]')?.textContent ===
          'tracked.log',
    )
    const firstTab = document.querySelector('.file-editor-tab')
    firstTab.querySelector('button[aria-label^="Close "]').click()
    await until(
      'inactive tab closed',
      () => document.querySelectorAll('.file-editor [role="tab"]').length === 1,
    )
    assert(
      document.querySelector('.file-editor [aria-selected="true"]').textContent === 'tracked.log',
      'closing another file switched the active tab',
    )
    document.querySelector('.file-editor-tab button[aria-label^="Close "]').click()
    await until('last tab closes editor pane', () => !document.querySelector('.file-editor'))
    await smoke.editorSavePreferences({
      fileOpenMode: 'external',
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

    // Overflow must affect only the tab strip, never the active terminal's controls.
    const crowdedIds = []
    for (let i = 0; i < 9; i++) {
      const id = state().addTerminal(
        'navigation',
        {
          id: `overflow-${i}`,
          name: `Terminal ${i} with a deliberately long label to exercise ellipsis and scrolling`,
          kind: 'shell',
          command: '',
        },
        false,
      )
      crowdedIds.push(id)
      await smoke.startTerminal('navigation', id)
    }
    const dock = () => document.querySelector('.terminal-dock')
    const strip = () => dock()?.querySelector('.dock-tabs')
    const actions = () => dock()?.querySelector('.dock-actions')
    const activeVisible = () => {
      const tab = strip()?.querySelector('.active')
      if (tab?.dataset.dockSession && tab.dataset.dockSession !== state().activeSession)
        return false
      const selected = tab?.getBoundingClientRect()
      const viewport = strip()?.getBoundingClientRect()
      return (
        selected &&
        viewport &&
        selected.left >= viewport.left - 1 &&
        selected.right <= viewport.right + 1
      )
    }
    const controlsVisible = () => {
      const box = actions()?.getBoundingClientRect()
      const header = dock()?.querySelector('.dock-header')?.getBoundingClientRect()
      return (
        box &&
        header &&
        box.left >= header.left - 1 &&
        box.right <= header.right + 1 &&
        [...actions().querySelectorAll('button')].every((button) => {
          const b = button.getBoundingClientRect()
          return b.left >= box.left && b.right <= box.right + 1
        })
      )
    }
    await smoke.resizeWindow(1440, 900)
    await until('overflowing tab strip', () => strip()?.scrollWidth > strip()?.clientWidth)
    const firstSid = smoke.sessionId('navigation', crowdedIds[0])
    const lastSid = smoke.sessionId('navigation', crowdedIds.at(-1))
    state().setActiveSession(firstSid)
    await until('first programmatic tab visible', activeVisible)
    state().setActiveSession(lastSid)
    await until('last programmatic tab visible', activeVisible)
    assert(controlsVisible(), 'dock actions clipped by overflowing tabs')
    assert(
      strip().querySelector('.active').title.includes('deliberately long label'),
      'full tab label lost',
    )
    const beforeScroll = actions().getBoundingClientRect().left
    strip().scrollLeft = 0
    await sleep(50)
    assert(actions().getBoundingClientRect().left === beforeScroll, 'actions scrolled with tabs')
    strip().querySelector('.tab').click()
    await until(
      'terminal tab click selected',
      () => state().activeSession === sid && activeVisible(),
    )

    // A contributed dock view can be selected, then overridden by a terminal reveal.
    const registry = state().extensions
    const extensionViews = state().extensionViews
    const viewId = 'navigation.smoke.dock'
    smoke.store.setState({
      extensions: {
        ...registry,
        extensions: [
          ...registry.extensions,
          {
            id: 'navigation.smoke',
            dir: '',
            enabled: true,
            errors: [],
            manifest: {
              name: 'smoke',
              publisher: 'navigation',
              version: '1.0.0',
              engines: { patchbay: '*' },
              activationEvents: [],
              permissions: [],
              contributes: {
                devices: [],
                detectors: [],
                commands: [],
                menus: {},
                context: [],
                views: [
                  {
                    id: viewId,
                    title: 'Extension dock view with a long descriptive label',
                    location: 'dock',
                  },
                ],
              },
            },
          },
        ],
      },
      extensionViews: { ...extensionViews, [viewId]: '<p>Dock extension smoke</p>' },
    })
    const extensionTab = await until('extension dock tab', () =>
      dock()?.querySelector(`[data-extension-view-tab="${viewId}"]`),
    )
    extensionTab.click()
    await until(
      'extension selected and visible',
      () => extensionTab.classList.contains('active') && activeVisible(),
    )
    assert(!actions(), 'terminal controls shown for extension view')
    state().setActiveSession(lastSid)
    state().revealDock(lastSid)
    await until('terminal reveal overrides extension', () => actions() && activeVisible())
    assert(state().activeSession === lastSid, 'reveal selected wrong terminal')
    smoke.store.setState({ extensions: registry, extensionViews })

    await smoke.resizeWindow(1024, 768)
    smoke.selectPanel('activity')
    await until('narrow dock action row', () => {
      const a = actions()?.getBoundingClientRect()
      const t = strip()?.getBoundingClientRect()
      return a && t && a.top >= t.bottom && controlsVisible() && activeVisible()
    })
    const dockButton = (text) =>
      [...actions().querySelectorAll('button')].find((b) => b.textContent.includes(text))
    dockButton('Stop').click()
    await until(
      'dock Stop exits terminal',
      () => !state().sessions[lastSid]?.running && dockButton('Restart'),
    )
    dockButton('Restart').click()
    await until(
      'dock Restart starts terminal',
      () => state().sessions[lastSid]?.running && dockButton('Stop'),
    )
    dockButton('Stop').click()
    await until('exited terminal closable', () => dock()?.querySelector('.dock-close'))
    dock().querySelector('.dock-close').click()
    await until('closed exited tab removed', () => !state().dockKept.includes(lastSid))
    for (const id of crowdedIds) {
      const session = smoke.sessionId('navigation', id)
      smoke.stopTerminal(session)
      await until('overflow session stopped', () => !state().sessions[session]?.running)
      state().dropFromDock(session)
      state().removeTerminal('navigation', id)
    }
    smoke.selectPanel(null)
    await smoke.resizeWindow(1440, 900)
    state().setActiveSession(sid)

    // Preference is global and survives a Canvas unmount, including a view change.
    const minimapPreference = localStorage.getItem('patchbay.canvasMinimapVisible')
    const minimapToggle = () => document.querySelector('.canvas-controls [aria-label="Minimap"]')
    if (minimapToggle().getAttribute('aria-pressed') === 'false') minimapToggle().click()
    await until('visible minimap', () => document.querySelector('.react-flow__minimap'))
    minimapToggle().click()
    await until(
      'hidden minimap persisted',
      () =>
        !document.querySelector('.react-flow__minimap') &&
        localStorage.getItem('patchbay.canvasMinimapVisible') === 'false',
    )
    smoke.selectRailView('implementation')
    await until('canvas unmounted', () => !minimapToggle())
    smoke.selectRailView('navigation')
    await until(
      'hidden minimap restored',
      () =>
        minimapToggle()?.getAttribute('aria-pressed') === 'false' &&
        !document.querySelector('.react-flow__minimap'),
    )
    minimapToggle().click()
    await until(
      'visible minimap persisted',
      () => localStorage.getItem('patchbay.canvasMinimapVisible') === 'true',
    )
    smoke.selectRailView('implementation')
    await until('canvas unmounted again', () => !minimapToggle())
    smoke.selectRailView('navigation')
    await until('visible minimap restored', () => document.querySelector('.react-flow__minimap'))
    if (minimapPreference === 'false') minimapToggle().click()
    if (minimapPreference == null) localStorage.removeItem('patchbay.canvasMinimapVisible')

    const navigationButton = document.querySelector('.workspace-rail [aria-label="Navigation"]')
    const activityButton = document.querySelector('.workspace-rail [aria-label="Activity"]')
    navigationButton.focus()
    await until('keyboard rail tooltip', () =>
      document.querySelector('[role="tooltip"]')?.textContent.includes('Navigation'),
    )
    assert(document.querySelector('[role="tooltip"] kbd'), 'rail shortcut missing from tooltip')
    assert(!navigationButton.title, 'duplicate native rail tooltip')
    navigationButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until('Escape dismisses rail tooltip', () => !document.querySelector('[role="tooltip"]'))
    navigationButton.blur()
    activityButton.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    await until('pointer rail tooltip', () =>
      document.querySelector('[role="tooltip"]')?.textContent.includes('Activity'),
    )
    activityButton.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    await until(
      'pointer leave dismisses rail tooltip',
      () => !document.querySelector('[role="tooltip"]'),
    )
    activityButton.click()
    await until(
      'view and utility remain selected together',
      () =>
        navigationButton.getAttribute('aria-pressed') === 'true' &&
        activityButton.getAttribute('aria-pressed') === 'true',
    )
    const utilityHandle = document.querySelector('.utility-resize')
    const utilityWidth = Number(utilityHandle.getAttribute('aria-valuenow'))
    utilityHandle.focus()
    utilityHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await until(
      'utility keyboard resize',
      () => Number(utilityHandle.getAttribute('aria-valuenow')) === utilityWidth - 20,
    )
    assert(
      Number(localStorage.getItem('patchbay.utilityPanelWidth')) === utilityWidth - 20,
      'utility width not persisted',
    )
    utilityHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    smoke.selectPanel(null)

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
    const terminalInput = document.querySelector('.xterm textarea')
    assert(terminalInput, 'terminal input missing')
    for (const key of ['s', '1', '2', '3', '4']) {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      terminalInput.dispatchEvent(event)
      assert(state().view === 'navigation', `Ctrl+${key} switched views from a terminal`)
    }
    await smoke.terminalWrite(sid, '\u0011\u0003')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))
    const input = await until('file search shortcut', () =>
      document.querySelector('input[aria-label="Search files and commands"]'),
    )
    await until('ranked path list', () =>
      document.querySelector('[aria-label="Files"] [role="option"]'),
    )
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'close')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until('close command matches during file search', () =>
      document.querySelector('[data-command-id="close"]'),
    )
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await sleep(50)
    assert(state().project?.id === projectId, 'fast file-search Enter closed the project')
    await until('no matching files', () =>
      document
        .querySelector('[role="group"][aria-label="Files"]')
        ?.textContent.includes('No matching files'),
    )
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await sleep(50)
    assert(state().project?.id === projectId, 'empty file-search Enter ran a command')
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
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    state().setActiveTask(task.id)
    await until('task search discards stale original files', () => {
      const dialog = document.querySelector('.search-results')
      return (
        dialog &&
        !dialog.textContent.includes('Searching…') &&
        !dialog.textContent.includes('root-only.txt')
      )
    })
    assert(
      document
        .querySelector('input[aria-label="Search files and commands"]')
        .getAttribute('aria-activedescendant') === 'search-result-0',
      'Search selection leaked across worktrees',
    )
    state().setActiveTask(null)
    document
      .querySelector('input[aria-label="Search files and commands"]')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const inspectorTab = (name) =>
      [...document.querySelectorAll('.inspector .tabs button')].find(
        (button) => button.textContent.trim() === name,
      )
    inspectorTab('Files').click()
    const tree = await until('file tree', () => document.querySelector('[role="tree"]'))
    const item = (name) =>
      [...tree.querySelectorAll('[role="treeitem"]')].find((row) => row.title === name)
    const key = (row, name) =>
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
      )
    const folder = await until('folder tree item', () => item('folder'))
    folder.focus()
    key(folder, 'ArrowRight')
    const child = await until('expanded child', () => item('folder/child.txt'))
    key(folder, 'ArrowRight')
    assert(document.activeElement === child, 'Right did not enter folder')
    key(child, 'ArrowLeft')
    assert(document.activeElement === folder, 'Left did not focus parent')
    key(folder, 'ArrowLeft')
    await until('collapsed folder', () => !item('folder/child.txt'))
    key(folder, 'Home')
    assert(
      document.activeElement === tree.querySelector('[role="treeitem"]'),
      'Home did not focus first item',
    )
    key(document.activeElement, 'End')
    assert(
      document.activeElement === [...tree.querySelectorAll('[role="treeitem"]')].at(-1),
      'End did not focus last item',
    )
    const fileRow = item(path)
    fileRow.focus()
    key(fileRow, 'Enter')
    assert(
      [...tree.querySelectorAll('[role="treeitem"][tabindex="0"]')].length === 1,
      'Tree has multiple tab stops',
    )
    const large = item('large-diff.txt')
    const diffButton = await until('large diff action', () =>
      large?.closest('.file-tree-row').querySelector('[title="Show diff"]'),
    )
    diffButton.click()
    const windowed = await until('windowed diff', () => document.querySelector('.windowed-diff'))
    assert(Number(windowed.getAttribute('aria-rowcount')) > 12500, 'Large diff rows missing')
    assert(
      windowed.querySelectorAll('[role="row"]').length < 200,
      'Large diff mounted too many rows',
    )
    const scroll = windowed.closest('.diff-view')
    await until('tab-indented diff line', () => windowed.querySelector('[data-new-line="3"]'))
    const width = scroll.scrollWidth
    scroll.scrollLeft = width
    const left = scroll.scrollLeft
    assert(left > 1000, 'Tab-indented line did not create a wide diff')
    scroll.scrollTop = scroll.scrollHeight
    scroll.dispatchEvent(new Event('scroll'))
    const last = await until('last diff line', () =>
      windowed.querySelector('[data-new-line="12500"]'),
    ).catch((error) => {
      throw new Error(
        `${error}: ${JSON.stringify({ top: scroll.scrollTop, height: scroll.clientHeight, total: scroll.scrollHeight, rows: windowed.getAttribute('aria-rowcount'), last: windowed.querySelector('[data-new-line]:last-of-type')?.getAttribute('data-new-line'), tail: windowed.textContent.slice(-100) })}`,
      )
    })
    assert(scroll.scrollWidth === width, 'Horizontal extent changed after tabbed row unmounted')
    assert(scroll.scrollLeft === left, 'Horizontal position clamped after tabbed row unmounted')
    const number = last.querySelector('.diff-num.new')
    const range = document.createRange()
    range.selectNodeContents(number)
    const digits = range.getBoundingClientRect()
    const cell = number.getBoundingClientRect()
    assert(digits.left >= cell.left && digits.right <= cell.right, 'Line number overflows gutter')
    assert(
      windowed.querySelectorAll('[role="row"]').length < 200,
      'Scrolled diff mounted too many rows',
    )
    inspectorTab('Component').click()
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
      'PASS navigation: overflowing dock tabs, fixed action rows, active tab reveal, terminal and extension selection, dock Stop/Restart/Close, persisted minimap, inspector disclosures, terminal controls, header menus and focus, single-click docked file tabs, save and close guards, safe argv, ignored/tracked files, denied symlink, generation/cwd checks, selection and modifier links, file search, keyboard tree navigation, windowed large diffs and editor setup',
    )
  } catch (e) {
    if (previous) await smoke.editorSavePreferences(previous).catch(() => {})
    if (sid) smoke.stopTerminal(sid)
    await smoke.report(`FAIL navigation: ${String(e)} ${e?.stack || ''}`)
  }
})()
