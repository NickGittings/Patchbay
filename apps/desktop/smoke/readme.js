// Stages each workspace view of the Northstar demo (smoke/readme-fixture.sh) for the README and
// reports `SHOT <name>` once it has settled; scripts/readme-shots.mjs captures the window then.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const query = (selector) => document.querySelector(selector)
  const click = (el) => {
    if (!el) throw new Error('missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const viewButton = (name) =>
    Array.from(document.querySelectorAll('.workspace-rail > button')).find(
      (b) => b.getAttribute('aria-label') === name,
    )
  const textOf = (sid) => smoke.terminalText(sid).text
  const running = (component, terminal, task) => {
    const sid = smoke.sessionId(component, terminal, task)
    return until(`${component}/${terminal} output`, () => state().sessions[sid]?.running && sid)
  }
  // WebKit stops painting terminals in a window something else covers, so raise it first, and
  // hold the view while the capture runs, so it never sees the next step.
  const shot = async (name) => {
    await smoke.focusWindow()
    await sleep(1500)
    await smoke.report(`SHOT ${name}`)
    await sleep(2500)
  }
  try {
    await smoke.resizeWindow(1440, 900)
    const opened = await smoke.openProject()
    if (!opened) throw new Error('project was not opened')
    state().loadProject(opened.project)
    await smoke.syncCurrentRoots()
    const root = opened.project.root
    // The Claude preset, played by the fixture's stand-in planner.
    state().setDevices(
      state().devices.map((d) =>
        d.id === 'claude' ? { ...d, command: `"${root}/../claude"` } : d,
      ),
    )
    const fit = async () => {
      click(await until('fit view', () => query('.react-flow__controls-fitview')))
      await sleep(400)
    }

    // Navigation: the map, the Web app's inspector and its running dev server.
    await until('map', () => query('.react-flow__node[data-id="web"]'))
    state().select('web')
    await smoke.startTerminal('web', 'dev')
    const web = await running('web', 'dev')
    await until('web server ready', () => textOf(web).includes('ready for product search'))
    state().setActiveSession(web)
    await fit()
    await shot('navigation')

    // Plan: Web app and Catalog in scope, a planner that saved its plan.
    click(viewButton('Plan'))
    await until('plan layout', () => query('.plan-dock'))
    state().select(null)
    state().toggleHighlight('web')
    state().toggleHighlight('catalog')
    state().setPlanActive('claude')
    await smoke.startTerminal('@plan', 'claude')
    const planner = await running('@plan', 'claude')
    await until('planner done', () => textOf(planner).includes('Implement →'))
    const saved = await until('saved plan', () =>
      Array.from(document.querySelectorAll('details')).find(
        (d) => d.querySelector('summary')?.textContent === 'Saved plan',
      ),
    )
    saved.open = true
    await fit()
    await shot('plan')

    // Build: the task worktree with its servers and passing tests.
    // The task's servers take the same ports.
    await smoke.stopTerminal(web)
    await until('web server stopped', () => !state().sessions[web]?.running)
    const worktree = (await smoke.gitWorktrees()).find((w) => w.branch === 'add-product-search')
    if (!worktree) throw new Error('fixture worktree missing')
    await smoke.taskAttach(worktree.path, 'Add product search', ['web', 'catalog'])
    await smoke.refreshTasks()
    const task = await until('task', () =>
      state().tasks.find((t) => t.branch === 'add-product-search'),
    )
    state().setActiveTask(task.id)
    state().setImplementationScope(['web', 'api', 'catalog'].map((id) => ({ id, visible: true })))
    click(viewButton('Build'))
    const shell = await until('shell tile', () => query('.terminal-tile[data-component="@task"]'))
    click(Array.from(shell.querySelectorAll('button')).find((b) => b.textContent.includes('Start')))
    const shellSid = shell.dataset.session
    await until('shell running', () => state().sessions[shellSid]?.running)
    await sleep(1500)
    // A plain prompt, without the user and host of whoever takes the shots.
    await smoke.terminalWrite(shellSid, "PS1='northstar $ '; PROMPT_EOL_MARK=''; clear\r")
    await sleep(500)
    await smoke.terminalWrite(shellSid, 'git status --short\r')
    for (const [c, t] of [
      ['web', 'dev'],
      ['api', 'dev'],
      ['catalog', 'test'],
    ]) {
      state().addTaskComponentTerminal(c, t)
      await smoke.startTerminal(c, t)
    }
    await until('tests passed', () =>
      textOf(smoke.sessionId('catalog', 'test', task.id)).includes('pass 5'),
    )
    await shot('build')

    // Review: the task's changes with the catalog diff open.
    click(viewButton('Review'))
    click(
      await until('search.js in changes', () =>
        query('.change-row[data-path="packages/catalog/search.js"]'),
      ),
    )
    await until('diff', () => query('.diff-file-header'))
    await shot('review')
    smoke.report('PASS readme screenshots')
  } catch (e) {
    smoke.report(`FAIL ${e?.message ?? e}`)
  }
})()
