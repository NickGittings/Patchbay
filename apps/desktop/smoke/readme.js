// Stages each workspace view of the Northstar demo (smoke/readme-fixture.sh) for the README and
// reports `SHOT <name>` once it has settled; scripts/readme-shots.mjs captures the window then and
// answers, and the script moves on only once the capture succeeded.
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
  // Waits for a terminal to print `text`, failing early once it exits.
  const printed = (sid, what, text) =>
    until(what, () => {
      if (textOf(sid).includes(text)) return true
      const session = state().sessions[sid]
      if (session && !session.running && session.exitCode !== undefined)
        throw new Error(`${what}: exited\n${textOf(sid)}`)
    })
  // WebKit stops painting terminals in a window something else covers, so raise it first, and
  // hold the view until the launcher has captured it.
  const shot = async (name) => {
    await smoke.focusWindow()
    await sleep(1500)
    const answer = await smoke.reportAndWait(`SHOT ${name}`)
    if (answer !== 'ok') throw new Error(`capturing ${name}: ${answer}`)
  }
  try {
    await smoke.resizeWindow(1440, 900)
    const opened = await smoke.openProject()
    if (!opened) throw new Error('project was not opened')
    state().loadProject(opened.project)
    await smoke.syncCurrentRoots()
    const root = opened.project.root
    // The Claude preset, played by the fixture's stand-in planner. The app loads presets on its
    // own too, so put the stand-in back whenever a load replaces it, until the planner started.
    const standIn = `"${root}/../claude"`
    const playClaude = () => {
      const devices = state().devices
      if (devices.some((d) => d.id === 'claude' && d.command !== standIn))
        state().setDevices(devices.map((d) => (d.id === 'claude' ? { ...d, command: standIn } : d)))
    }
    await smoke.refreshExtensions()
    playClaude()
    const stopPlaying = smoke.store.subscribe(playClaude)
    const fit = async () => {
      click(await until('fit view', () => query('.react-flow__controls-fitview')))
      await sleep(400)
    }

    // Navigation: the map, the Web app's inspector and its running dev server.
    await until('map', () => query('.react-flow__node[data-id="web"]'))
    state().select('web')
    await smoke.startTerminal('web', 'dev')
    const web = await running('web', 'dev')
    await printed(web, 'web server ready', 'ready for product search')
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
    if (state().devices.find((d) => d.id === 'claude')?.command !== standIn)
      throw new Error('the stand-in planner is not the Claude preset')
    await smoke.startTerminal('@plan', 'claude')
    stopPlaying()
    const planner = await running('@plan', 'claude')
    // Only the stand-in prints this; stop anything else at once.
    await until(
      'stand-in planner',
      () => textOf(planner).includes('Plan product search'),
      10000,
    ).catch(async (e) => {
      await smoke.stopTerminal(planner)
      throw e
    })
    await printed(planner, 'planner done', 'Implement →')
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
    // A clean shell, so the prompt shows no user, host or theme and nothing reaches the user's
    // history: not the login shell the Shell tile opens by default.
    smoke.store.setState({
      rootTerminals: state().rootTerminals.map((t) =>
        t.id === 'shell'
          ? {
              ...t,
              command:
                `exec env -i PATH="$PATH" TERM="$TERM" HOME="${root}/.." HISTFILE=/dev/null ` +
                "BASH_SILENCE_DEPRECATION_WARNING=1 PS1='northstar $ ' /bin/sh -i",
            }
          : t,
      ),
    })
    state().setImplementationScope(['web', 'api', 'catalog'].map((id) => ({ id, visible: true })))
    click(viewButton('Build'))
    const shell = await until('shell tile', () => query('.terminal-tile[data-component="@task"]'))
    click(Array.from(shell.querySelectorAll('button')).find((b) => b.textContent.includes('Start')))
    const shellSid = shell.dataset.session
    await until('shell running', () => state().sessions[shellSid]?.running)
    await printed(shellSid, 'shell prompt', 'northstar $')
    // Clears whatever the login shell that execs it printed.
    await smoke.terminalWrite(shellSid, 'clear\r')
    await sleep(500)
    await smoke.terminalWrite(shellSid, 'git status --short\r')
    await printed(shellSid, 'git status', 'search.test.js')
    for (const [c, t] of [
      ['web', 'dev'],
      ['api', 'dev'],
      ['catalog', 'test'],
    ]) {
      state().addTaskComponentTerminal(c, t)
      await smoke.startTerminal(c, t)
    }
    const sid = (c, t) => smoke.sessionId(c, t, task.id)
    await printed(sid('catalog', 'test'), 'tests passed', 'pass 5')
    await printed(sid('web', 'dev'), 'task web server ready', 'ready for product search')
    await printed(sid('api', 'dev'), 'task API server ready', 'accepting requests')
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
