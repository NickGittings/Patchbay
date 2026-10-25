// Stack detection by an agent: its proposal reaches the Stack panel and applies as map edits.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 30000
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  if (new URLSearchParams(location.search).has('component')) return
  const button = (root, text) =>
    Array.from(root?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent.trim().startsWith(text),
    )
  try {
    const opened = await smoke.openProject()
    smoke.resetSessions(await smoke.terminalReset())
    const component = (id, terminals, x) => ({
      id,
      name: id.toUpperCase(),
      path: '.',
      kind: 'service',
      notes: '',
      terminals,
      position: { x, y: 100 },
    })
    const project = {
      ...opened.project,
      components: [
        component('api', [{ id: 'serve', name: 'Serve', kind: 'task', command: 'make api' }], 0),
        component('web', [], 350),
      ],
      links: [{ id: 'wa', source: 'web', target: 'api' }],
      groups: [],
    }
    state().loadProject(project)
    await smoke.syncAgentProject(state().toProject())
    const stack = {
      version: 1,
      name: 'Local stack',
      orderedStartup: true,
      terminals: [
        { component: 'api', terminal: 'serve', readyWhen: 'Listening on', reason: 'Makefile:3' },
        {
          component: 'web',
          name: 'Vite',
          command: 'npx vite',
          readyWhen: 'ready in',
          reason: 'web/vite.config.ts:1',
        },
      ],
    }
    state().setDevices([
      {
        id: 'smoke-stacker',
        name: 'Smoke stacker',
        category: 'agent',
        kind: 'agent',
        source: 'builtin',
        // Its token may propose a stack but run nothing.
        command:
          `"$PATCHBAY_CLI" agent environment start none 2>&1; echo "start-exit:$?"; ` +
          `printf '%s' '${JSON.stringify(stack)}' | "$PATCHBAY_CLI" agent propose-stack --file -; exec cat`,
      },
    ])
    smoke.selectPanel('stack')
    const panel = await until('stack panel', () => document.querySelector('.component-groups'))
    const detect = await until('detect button', () => button(panel, 'Detect stack with an agent'))
    detect.click()
    const sid = smoke.sessionId('@map', 'stack', null)
    await until('agent submission', () =>
      smoke.terminalText(sid).text.replace(/\s+/g, '').includes('"submitted":2'),
    )
    assert(
      /start-exit:[1-9]/.test(smoke.terminalText(sid).text),
      'stack detection was allowed to start an environment',
    )
    smoke.selectPanel('stack')
    const review = await until('proposed stack', () =>
      document.querySelector('[aria-label="Proposed stack"]'),
    )
    assert(review.textContent.includes('Makefile:3'), 'the reason must be shown')
    assert(review.textContent.includes('Vite (new)'), 'a new terminal must be marked new')
    button(review, 'Apply').click()
    await until('stack applied', () => state().groups.length === 1)
    const [group] = state().groups
    assert(group.name === 'Local stack' && group.orderedStartup, 'stack settings lost')
    assert(group.componentIds.join(',') === 'api,web', `members ${group.componentIds}`)
    const api = state().nodes.find((n) => n.id === 'api').data.terminals[0]
    assert(api.action === 'development' && api.readyWhen === 'Listening on', 'api not marked')
    const web = state().nodes.find((n) => n.id === 'web').data.terminals[0]
    assert(
      web?.command === 'npx vite' && web.action === 'development' && web.kind === 'task',
      'new terminal not added',
    )
    await until('proposal cleared', () => !document.querySelector('[aria-label="Proposed stack"]'))
    assert(!(await smoke.stackProposalRead(state().project.id)), 'applied proposal stayed on disk')
    smoke.stopTerminal(sid)
    await smoke.report('PASS stack: agent proposal, refused run, review, apply, clear')
  } catch (e) {
    await smoke.report(`FAIL stack: ${e?.message ?? e} ${e?.stack ?? ''}`)
  }
})()
