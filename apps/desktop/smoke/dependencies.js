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
    smoke.selectPanel('project')
    const item = await until('Create map configuration', () =>
      Array.from(document.querySelectorAll('.utility-panel button')).find((b) =>
        b.textContent.trim().startsWith('Create map configuration'),
      ),
    )
    item.click()
  }
  const pair = (l) => `${l.source}->${l.target}`
  const positions = () => Object.fromEntries(s().nodes.map((n) => [n.id, { ...n.position }]))
  const undoButton = () =>
    Array.from(document.querySelectorAll('.toast button')).find(
      (b) => b.textContent.trim() === 'Undo layout',
    )
  const arrange = async () => {
    s().setPaletteOpen(true)
    const command = await until('Arrange command', () =>
      document.querySelector('[data-command-id="arrange-map"]'),
    )
    command.click()
    await until('layout action', undoButton)
  }
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
    smoke.store.setState({
      edges: [],
      nodes: s().nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 30 } })),
      dirty: true,
    })

    await create()
    await until('manifest review after the first save', () =>
      dialog()?.textContent.includes('Review detected dependencies'),
    )
    assert(dialog().textContent.includes('→'), 'the manifest link must be listed')
    const manifestReview = smoke.dependencies.getState().dialogs[one.id]

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
      // With its own token it may read status, but running a check must be refused, before it
      // submits its proposal.
      command:
        `"$PATCHBAY_CLI" agent status >/dev/null && echo status-ok; ` +
        `"$PATCHBAY_CLI" agent validate ${api} 2>&1; echo "validate-exit:$?"; ` +
        `printf '%s' '${JSON.stringify(links)}' | "$PATCHBAY_CLI" agent propose-links --file -; exec cat`,
    }
    s().setDevices([agent])
    await click('Add selected and detect with an agent')
    await until('manifest link added', () =>
      s().edges.some((e) => e.source === jobs && e.target === api),
    )
    const manifestUndo = s().messageAction
    assert(manifestUndo?.label === 'Undo layout', 'adding before an agent must offer layout Undo')
    const sid = smoke.sessionId('@map', 'detect', null)
    await until('agent submission', () =>
      smoke.terminalText(sid).text.replace(/\s+/g, '').includes('"submitted":1'),
    )
    await until('agent review', () =>
      dialog()?.textContent.includes('Review proposed dependencies'),
    )
    assert(dialog().textContent.includes('web/src/api.ts:1'), 'the reason must be shown')
    // A conflict arriving while the review is open must stop both the controls and edits.
    await until('manifest autosave before conflict', () => !s().dirty)
    await smoke.saveProject({ ...s().toProject(), name: 'Edited externally' }, null)
    s().updateComponent(web, { notes: 'Local edit during dependency review' })
    await until('map conflict', () => s().projects[one.id].mapSave?.status === 'conflict')
    await until('blocked dependency review', () => button('Add selected')?.disabled)
    assert(
      Array.from(dialog().querySelectorAll('input[type="checkbox"]')).every((c) => c.disabled),
      'a conflicted review must disable its selections',
    )
    button('Add selected').click()
    assert(!s().edges.some((e) => e.source === web && e.target === api), 'conflict added a link')
    assert(await smoke.mapLinksRead(one.id), 'a blocked review must retain its proposal')
    assert((await smoke.openProject()).project.name === 'Edited externally', 'external edit lost')
    const conflictedPositions = JSON.stringify(positions())
    manifestUndo.run()
    assert(JSON.stringify(positions()) === conflictedPositions, 'Undo edited a conflicted map')
    assert(!s().message.includes('Restored'), 'blocked Undo reported success')
    // Explicit replacement resolves the conflict; the same review can then apply normally.
    assert(await smoke.saveMap(one.id, true), 'conflict replacement failed')
    await until('review enabled after recovery', () => !button('Add selected')?.disabled)
    const before = positions()
    await click('Add selected')
    await until('agent link added', () =>
      s().edges.some((e) => e.source === web && e.target === api),
    )
    // Accepting rearranges the map by dependencies, and the toast can undo that.
    const after = positions()
    assert(after[web].x < after[api].x, `web must sit left of api: ${JSON.stringify(after)}`)
    assert(after[jobs].x < after[api].x, `jobs must sit left of api: ${JSON.stringify(after)}`)
    const undo = await until('Undo in the toast', undoButton)
    undo.click()
    await until('layout restored', () => JSON.stringify(positions()) === JSON.stringify(before))
    // The review closes once the proposal is cleared, so no stale read can bring it back.
    await until('the review closes', () => !dialog())
    assert((await smoke.mapLinksRead(one.id)) === null, 'the reviewed proposal must be cleared')
    await until('autosave', () => !s().dirty)
    const saved = (await smoke.openProject()).project.links
    const byPair = Object.fromEntries(saved.map((l) => [pair(l), l]))
    assert(byPair[`${jobs}->${api}`]?.detection?.detector === 'builtin', 'manifest link not saved')
    const agentLink = byPair[`${web}->${api}`]
    assert(agentLink?.detection?.detector === 'agent', 'agent link not saved with its origin')
    assert(agentLink.label === 'REST', 'agent label not saved')
    // The detection agent's token reads status but can't run graph actions.
    const output = smoke.terminalText(sid).text.replace(/\s+/g, '')
    assert(output.includes('status-ok'), `status must be readable: ${output}`)
    assert(
      output.includes('onlyreadcontextandproposelinks'),
      `validate must be refused for its role: ${output}`,
    )
    assert(/validate-exit:[1-9]/.test(output), `a refused validate must fail: ${output}`)
    assert(s().sessions[sid]?.running, 'the detection agent should still run')

    // Review a manifest link again with every proposal unchecked. Starting (or revealing) the
    // agent must leave the map and feedback alone instead of saying "Nothing new to add".
    const savedEdges = s().edges
    smoke.store.setState({
      edges: savedEdges.filter((e) => !(e.source === jobs && e.target === api)),
    })
    smoke.dependencies.setState((state) => ({
      dialogs: { ...state.dialogs, [one.id]: manifestReview },
    }))
    await until('manifest review reopened', () =>
      dialog()?.textContent.includes('Review detected dependencies'),
    )
    for (const checkbox of dialog().querySelectorAll('input[type="checkbox"]')) {
      if (checkbox.checked) checkbox.click()
    }
    await until('no dependencies selected', () => button('Detect with an agent'))
    s().setMessage('Detecting dependencies')
    const messageId = s().messageId
    await click('Detect with an agent')
    await until('detection review closed', () => !dialog())
    assert(s().messageId === messageId, 'launching without selected links changed the feedback')
    assert(s().edges.length === savedEdges.length - 1, 'launching added unchecked links')
    assert(!s().dirty, 'launching without selected links dirtied the map')
    smoke.store.setState({ edges: savedEdges })

    // Starting from a compact cluster makes fitting the old bounds visibly wrong.
    const cluster = () =>
      smoke.store.setState({
        nodes: s().nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 30 } })),
        dirty: true,
      })
    await sleep(900)
    cluster()
    await sleep(50)
    const fit = document.querySelector('.react-flow__controls-fitview')
    fit.click()
    await sleep(100)
    await arrange()
    await sleep(1000)
    const canvas = document.querySelector('.react-flow').getBoundingClientRect()
    for (const n of document.querySelectorAll('.react-flow__node')) {
      const r = n.getBoundingClientRect()
      assert(
        r.left >= canvas.left - 1 &&
          r.right <= canvas.right + 1 &&
          r.top >= canvas.top - 1 &&
          r.bottom <= canvas.bottom + 1,
        `arranged component is off-screen: ${n.dataset.id}`,
      )
    }

    // Grab a node while it is still tweening; it must follow the pointer immediately and stay
    // there when the rest of the animation ends, including after releasing it mid-tween.
    cluster()
    await sleep(50)
    s().setMessage('')
    await arrange()
    const node = document.querySelector(`.react-flow__node[data-id="${api}"]`)
    const initial = node.getBoundingClientRect()
    const x = initial.left + initial.width / 2
    const y = initial.top + 15
    const mouse = (target, type, clientX, clientY) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          view: window,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          clientX,
          clientY,
        }),
      )
    mouse(node, 'mousedown', x, y)
    // React Flow starts the drag after crossing its movement threshold.
    mouse(window, 'mousemove', x + 2, y + 2)
    mouse(window, 'mousemove', x + 27, y + 22)
    await sleep(30)
    const dragged = node.getBoundingClientRect()
    assert(
      Math.abs(dragged.left - initial.left - 25) < 3,
      `dragged node lagged behind the pointer: ${dragged.left - initial.left}`,
    )
    assert(Math.abs(dragged.top - initial.top - 20) < 3, 'dragged node jumped vertically')
    mouse(window, 'mouseup', x + 27, y + 22)
    assert(!s().nodes.some((n) => n.dragging), 'dropping left the map in a dragging state')
    const dropped = { ...s().nodes.find((n) => n.id === api).position }
    await sleep(500)
    const settled = node.getBoundingClientRect()
    assert(Math.abs(settled.left - dragged.left) < 3, 'node resumed tweening after release')
    assert(Math.abs(settled.top - dragged.top) < 3, 'node moved after release')
    undoButton().click()
    assert(JSON.stringify(positions()[api]) === JSON.stringify(dropped), 'Undo lost the later drag')

    // Crossing only the drag threshold starts and stops the drag without moving a node. This
    // must clear the dragging flag while leaving a saved map clean.
    await until('Undo autosaved', () => !s().dirty)
    await sleep(500)
    const stationary = node.getBoundingClientRect()
    const stationaryX = stationary.left + stationary.width / 2
    const stationaryY = stationary.top + 15
    mouse(node, 'mousedown', stationaryX, stationaryY)
    mouse(window, 'mousemove', stationaryX + 2, stationaryY + 2)
    mouse(window, 'mouseup', stationaryX + 2, stationaryY + 2)
    assert(!s().nodes.some((n) => n.dragging), 'a stationary drag left autosave waiting')
    assert(!s().dirty, 'a stationary drag dirtied the map')
    await sleep(50)

    // Selection-box drags also fire node drag callbacks. Each node's start and stop should
    // reach the map once, including when no actual movement follows the threshold.
    s().onNodesChange(s().nodes.map((n) => ({ id: n.id, type: 'select', selected: false })))
    await sleep(50)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft' }))
    const pane = await until('selection mode', () =>
      document.querySelector('.react-flow__pane.selection'),
    )
    const bounds = Array.from(document.querySelectorAll('.react-flow__node')).map((n) =>
      n.getBoundingClientRect(),
    )
    // Synthetic pointers cannot be captured by the OS; dispatch the entire gesture to the pane.
    pane.setPointerCapture = () => {}
    pane.releasePointerCapture = () => {}
    const pointer = (type, x, y) =>
      pane.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
          button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x,
          clientY: y,
        }),
      )
    const left = Math.min(...bounds.map((b) => b.left)) - 5
    const top = Math.min(...bounds.map((b) => b.top)) - 5
    const right = Math.max(...bounds.map((b) => b.right)) + 5
    const bottom = Math.max(...bounds.map((b) => b.bottom)) + 5
    pointer('pointerdown', left, top)
    await sleep(50)
    pointer('pointermove', right, bottom)
    await sleep(50)
    await until('nodes selected by the box', () => s().nodes.every((n) => n.selected))
    await sleep(50)
    pointer('pointerup', right, bottom)
    delete pane.setPointerCapture
    delete pane.releasePointerCapture
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }))
    const selection = await until('selection box', () =>
      document.querySelector('.react-flow__nodesselection-rect'),
    )
    const updateNodes = s().onNodesChange
    const dragUpdates = []
    smoke.store.setState({
      onNodesChange: (changes) => {
        dragUpdates.push(...changes.filter((c) => c.type === 'position'))
        updateNodes(changes)
      },
    })
    await sleep(50)
    const box = selection.getBoundingClientRect()
    const boxX = box.left + box.width / 2
    const boxY = box.top + 5
    mouse(selection, 'mousedown', boxX, boxY)
    mouse(window, 'mousemove', boxX + 2, boxY + 2)
    mouse(window, 'mouseup', boxX + 2, boxY + 2)
    smoke.store.setState({ onNodesChange: updateNodes })
    for (const n of s().nodes) {
      const updates = dragUpdates.filter((c) => c.id === n.id)
      assert(updates.length === 2, `selection drag sent ${updates.length} updates for ${n.id}`)
      assert(updates[0].dragging && !updates[1].dragging, 'selection drag did not finish')
    }
    assert(!s().dirty, 'a stationary selection drag dirtied the map')
    s().onNodesChange(s().nodes.map((n) => ({ id: n.id, type: 'select', selected: false })))

    // Project actions disappear in another tab and even a retained callback cannot edit it.
    await sleep(900)
    await arrange()
    // Releasing immediately after crossing the threshold must also finish the drag, even if
    // React Flow has not emitted a position change of its own yet.
    const grabbed = node.getBoundingClientRect()
    const grabX = grabbed.left + grabbed.width / 2
    const grabY = grabbed.top + 15
    mouse(node, 'mousedown', grabX, grabY)
    mouse(window, 'mousemove', grabX + 2, grabY + 2)
    mouse(window, 'mouseup', grabX + 2, grabY + 2)
    assert(!s().nodes.some((n) => n.dragging), 'a threshold-only drag left autosave waiting')
    // D3 suppresses clicks through the next tick after a drag.
    await sleep(50)
    const projectUndo = s().messageAction
    const firstPositions = JSON.stringify(positions())

    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    await until('project action hidden', () => !undoButton())
    projectUndo.run()
    const backgroundPositions = Object.fromEntries(
      s()
        .captureProjects()
        [one.id].state.nodes.map((n) => [n.id, n.position]),
    )
    assert(JSON.stringify(backgroundPositions) === firstPositions, 'Undo edited another project')
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
    const allNodes = s().nodes
    for (const count of [0, 1]) {
      smoke.store.setState({ nodes: allNodes.slice(0, count) })
      s().setPaletteOpen(true)
      await until('palette open', () => document.querySelector('.search-results'))
      assert(
        !document.querySelector('[data-command-id="arrange-map"]'),
        'Arrange offered for a small map',
      )
      s().setPaletteOpen(false)
      await sleep(50)
    }
    smoke.store.setState({ nodes: allNodes })
    await smoke.report('PASS dependency detection')
  } catch (e) {
    await smoke.report(`FAIL ${String(e)}\n${e?.stack ?? ''}`)
  }
})()
