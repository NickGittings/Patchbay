// External harness launches this twice. The second launch must recover without starting work.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await sleep(100)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  const popout = new URLSearchParams(location.search).get('component')
  if (popout !== null) return
  const state = () => smoke.store.getState()
  try {
    await until('restore', () => !state().restoring)
    await until('service', () => state().serviceConnected)
    if (window.__patchbayRecoveryPhase === 5) {
      await until('invalid workspace error', () => state().message.includes('Invalid workspace'))
      if (state().projectOrder.length) throw new Error('Malformed workspace mounted projects')
      await sleep(800)
      await smoke.report(
        'PASS malformed workspace: error visible, autosave and native geometry preserve original document',
      )
    } else if (window.__patchbayRecoveryPhase) {
      state().activateProject(state().projectOrder[0])
      const entry = state().projects[state().activeProjectId]
      if (!entry.conflict || state().dirty || state().nodes[0].data.notes !== 'external edit')
        throw new Error('Changed saved map did not preserve a separate conflicting draft')
      await until('recovery controls', () => document.querySelector('.recovery-banner'))
      if (window.__patchbayRecoveryPhase === 4) {
        const button = [...document.querySelectorAll('.recovery-banner button')].find(
          (b) => b.textContent === 'Recover draft',
        )
        button.click()
        if (!state().dirty || state().nodes[0].data.notes !== 'recovery draft')
          throw new Error('Explicit recovery did not restore the dirty draft')
      }
      await smoke.flushWorkspace()
      await smoke.report(
        `PASS draft conflict phase ${window.__patchbayRecoveryPhase}: conflict retained across quit, explicit recovery`,
      )
    } else if (state().projectOrder.length === 0) {
      const first = await smoke.openProject()
      smoke.acceptOpened(first)
      state().updateComponent('shared', { notes: 'recovery draft' })
      state().select('shared')
      state().setView('plan')
      state().toggleHighlight('shared')
      state().setViewport({ x: 77, y: 88, zoom: 0.75 })
      await smoke.startTerminal('shared', 'counter')
      await until('counter', () => state().sessions[smoke.sessionId('shared', 'counter')]?.running)
      await smoke.openComponentWindow('shared', 'Shared')
      await until('extension registry', () =>
        state().commands.some((c) => c.id === 'fixture.continuity.run'),
      )
      await until('startup badge in first project', () =>
        state().extensionBadges.shared?.some((b) => b.text === 'one'),
      )
      const pendingLaunch = smoke.executeExtensionCommand('fixture.continuity.run')
      const second = await smoke.openSecondProject()
      smoke.acceptOpened(second)
      state().select('shared')
      await until('startup badge in second project', () =>
        state().extensionBadges.shared?.some((b) => b.text === 'two'),
      )
      const viewTab = await until('second project view tab', () =>
        document.querySelector('button[data-extension-view-tab="fixture.continuity.panel"]'),
      )
      viewTab.click()
      const view = await until('second project extension view', () =>
        document.querySelector('iframe[data-extension-view="fixture.continuity.panel"]'),
      )
      await sleep(150)
      view.contentWindow.postMessage({ patchbay: 1, value: 'probe' }, '*')
      await until(
        'view message routed to second project',
        async () => (await smoke.extensionStorageGet('fixture.continuity'))['view-owner'] === 'two',
      )
      const launched = await pendingLaunch
      await smoke.reconcileSessions()
      if (
        !launched.output.includes('extension-origin') ||
        state().sessionRecords.find((r) => r.id === launched.sessionId)?.metadata.projectId !==
          first.id
      )
        throw new Error('Tab switching cancelled or redirected an extension launch')
      state().setView('review')
      state().activateProject(first.id)
      await smoke.flushWorkspace()
      await smoke.report(
        'PASS lifecycle phase 1: two tabs, draft, viewport, pop-out and running counter saved',
      )
    } else {
      if (state().projectOrder.length !== 2) throw new Error('Tabs were not restored')
      const id = state().projectOrder[0]
      state().activateProject(id)
      if (state().nodes[0].data.notes !== 'recovery draft' || !state().dirty)
        throw new Error('Recovery draft was lost or marked saved')
      if (
        state().view !== 'plan' ||
        state().viewport.x !== 77 ||
        !state().highlighted.includes('shared')
      )
        throw new Error('Layout or planner scope was not restored')
      const sid = smoke.sessionId('shared', 'counter')
      await until('live counter', () => state().sessions[sid]?.running)
      const text = await until('retained output', () => {
        const text = smoke.terminalText(sid).text
        return text.includes('number:') && text
      })
      if (text.split('process:').length !== 2)
        throw new Error('Counter was duplicated or not replayed')
      await until('restored pop-out', async () =>
        (await smoke.windowLabels()).some((label) => label.startsWith('component-')),
      )
      state().setView('navigation')
      state().select('shared')
      const terminal = state().nodes[0].data.terminals[0]
      state().addRuntimeTerminal(sid, { projectId: id, componentId: 'shared', terminal })
      await until(
        'single mapped terminal tab',
        () =>
          [...document.querySelectorAll('.terminal-dock .tabs .tab')].filter((b) =>
            b.textContent.includes('Counter'),
          ).length === 1,
      )
      await smoke.reconcileSessions()
      if (state().runtimeTerminals[sid])
        throw new Error('Mapped terminal remained in runtime registry')
      smoke.store.setState({ sessionsPanelOpen: true })
      const reconnect = await until('counter reconnect button', () =>
        [...document.querySelectorAll('.session-row')]
          .find((row) => row.textContent.includes(state().project.root))
          ?.querySelector('button'),
      )
      reconnect.click()
      await until('session preview', () => document.querySelector('.session-preview .xterm-host'))
      smoke.store.setState({ sessionsPanelOpen: false })
      await until('terminal returned to dock', () =>
        document.querySelector('.terminal-dock .terminal-host .xterm-host'),
      )
      state().setView('plan')
      const secondId = state().projectOrder[1]
      state().activateProject(secondId)
      if (state().view !== 'review') throw new Error('Independent second layout was lost')
      await smoke.report(
        'PASS lifecycle phase 2: restored tabs, dirty draft, independent layouts, viewport, planner scope, pop-out and same live counter',
      )
    }
  } catch (e) {
    await smoke.report(`FAIL lifecycle: ${e.message ?? e}`)
  }
})()
