// Dependency detection after the first save: manifest links, then an agent's proposal, reviewed.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`timed out: ${what}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  const s = () => smoke.store.getState()
  const dialog = () => document.querySelector('.map-maintenance-dialog')
  const button = (text) =>
    Array.from(dialog()?.querySelectorAll('button') ?? []).find((b) =>
      b.textContent.trim().startsWith(text),
    )
  const click = async (text) => {
    const b = await until(`${text} button`, () => button(text))
    assert(!b.disabled, `${text} unexpectedly disabled`)
    b.click()
  }
  const create = async () => {
    const trigger = Array.from(document.querySelectorAll('.toolbar .menu-trigger')).find((b) =>
      b.textContent.trim().startsWith('Project'),
    )
    trigger.click()
    const item = await until('Create map configuration', () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) =>
        b.textContent.trim().startsWith('Create map configuration'),
      ),
    )
    item.click()
  }
  const pair = (l) => `${l.source}->${l.target}`
  try {
    await until('restoration', () => !s().restoring)
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    assert(one.detected, 'the fixture must start without patchbay.json')
    const ids = s().nodes.map((n) => n.id)
    const jobs = ids.find((id) => id.includes('jobs'))
    const api = ids.find((id) => id.includes('api'))
    const web = ids.find((id) => id.includes('web'))
    assert(jobs && api && web, `unexpected components ${ids}`)
    assert(
      s().edges.some((e) => e.source === jobs && e.target === api),
      'opening must already link a folder reference',
    )
    // A map with that link wouldn't be offered detection, so start from none.
    smoke.store.setState({ edges: [], dirty: true })

    await create()
    await until('manifest review after the first save', () =>
      dialog()?.textContent.includes('Review detected dependencies'),
    )
    assert(dialog().textContent.includes('→'), 'the manifest link must be listed')

    const links = {
      version: 1,
      links: [{ source: web, target: api, label: 'REST', reason: 'web/src/api.ts:1' }],
    }
    const agent = {
      id: 'smoke-mapper',
      name: 'Smoke mapper',
      category: 'agent',
      kind: 'agent',
      source: 'builtin',
      command: `printf '%s' '${JSON.stringify(links)}' | "$PATCHBAY_CLI" agent propose-links --file -; exec cat`,
    }
    s().setDevices([agent])
    await click('Add selected and detect with an agent')
    await until('manifest link added', () =>
      s().edges.some((e) => e.source === jobs && e.target === api),
    )
    const sid = smoke.sessionId('@map', 'detect', null)
    await until('agent submission', () =>
      smoke.terminalText(sid).text.replace(/\s+/g, '').includes('"submitted":1'),
    )
    await until('agent review', () =>
      dialog()?.textContent.includes('Review proposed dependencies'),
    )
    assert(dialog().textContent.includes('web/src/api.ts:1'), 'the reason must be shown')
    await click('Add selected')
    await until('agent link added', () =>
      s().edges.some((e) => e.source === web && e.target === api),
    )
    assert(!dialog(), 'the review must close')
    assert((await smoke.mapLinksRead(one.id)) === null, 'the reviewed proposal must be cleared')
    await until('autosave', () => !s().dirty)
    const saved = (await smoke.openProject()).project.links
    const byPair = Object.fromEntries(saved.map((l) => [pair(l), l]))
    assert(byPair[`${jobs}->${api}`]?.detection?.detector === 'builtin', 'manifest link not saved')
    const agentLink = byPair[`${web}->${api}`]
    assert(agentLink?.detection?.detector === 'agent', 'agent link not saved with its origin')
    assert(agentLink.label === 'REST', 'agent label not saved')
    // The detection agent can't run graph actions.
    assert(
      smoke.terminalText(sid).text.length > 0 && s().sessions[sid]?.running,
      'the detection agent should still run',
    )

    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    await create()
    await until('offer after an empty scan', () =>
      dialog()?.textContent.includes('name no dependencies'),
    )
    await click('Not now')
    assert(!dialog(), 'Not now must close the offer')
    assert(s().dependencyPromptDismissed, 'Not now must be remembered')
    assert(!s().dirty, 'declining must not edit the map')
    const layout = smoke
      .workspaceDocument()
      .projects.find((p) => p.root === two.project.root)?.layout
    assert(layout?.dependencyPromptDismissed === true, 'the decline must be in the layout')
    assert(!(await smoke.openSecondProject()).project.dependencyPromptDismissed, 'not in the map')
    await smoke.report('PASS dependency detection')
  } catch (e) {
    await smoke.report(`FAIL ${e?.stack ?? e}`)
  }
})()
