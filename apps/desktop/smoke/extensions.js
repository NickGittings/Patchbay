// Real desktop extension integration: static contributions, host, UI and opaque-origin isolation.
;(async () => {
  if (window.__patchbayExtensionsSmoke) return
  window.__patchbayExtensionsSmoke = true
  const until = async (name, check, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out waiting for ${name}`)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const click = (element) => {
    assert(element, 'missing click target')
    element.click()
  }
  try {
    await until('example registry', () =>
      state().extensions.extensions.some((e) => e.id === 'acme.docker' && e.enabled),
    )
    assert(
      state().devices.some((d) => d.id === 'compose-logs' && d.source === 'extension:acme.docker'),
      'extension device missing',
    )
    const opened = await smoke.openProject()
    state().loadProject(opened.project)
    const component = opened.project.components.find((c) => c.terminals.some((t) => t.id === 'up'))
    assert(component, 'extension detector did not claim compose.yaml')
    state().select(component.id)
    const when = { component, files: new Set(['compose.yaml']), view: 'navigation' }
    for (const [clause, expected] of [
      ["component.kind == 'service' && component.hasFile('compose.yaml')", true],
      ["!component.hasTerminal('missing') && (view == 'plan' || view != 'implementation')", true],
      ["component.id == 'missing' || component.hasFile('missing')", false],
      ["component.kind == 'service' &&", false],
      ['unknown || true', false],
      ["component.hasFile('compose.yaml');alert(1)", false],
    ])
      assert(smoke.evaluateWhen(clause, when) === expected, `incorrect when evaluation: ${clause}`)
    await until('extension badge', () =>
      document.querySelector(`[data-extension-badge="${component.id}"]`),
    )
    if (/mac/i.test(navigator.userAgent)) {
      await until('eligible native extension command', async () =>
        (await smoke.inspectNativeMenu()).some(
          ([id, , enabled]) => id === 'patchbay:extension:acme.docker.refresh' && enabled,
        ),
      )
    }
    const briefing = await smoke.componentContext(state().toProject(), component.id)
    assert(
      briefing.includes('## Services') && briefing.includes('services:'),
      'file contribution missing from context',
    )
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }),
    )
    await until('palette', () => document.querySelector('.search-results'))
    click(
      await until('palette command', () =>
        document.querySelector('[data-command-id="acme.docker.up"]'),
      ),
    )
    const sid = smoke.sessionId(component.id, 'ext-acme.docker.up')
    await until('command session', () => state().sessions[sid])
    assert(
      !state()
        .toProject()
        .components.some((c) => c.terminals.some((t) => t.id === 'ext-acme.docker.up')),
      'ad-hoc session modified project',
    )
    click(
      await until('Inspector view tab', () =>
        document.querySelector('[data-extension-view-tab="acme.docker.panel"]'),
      ),
    )
    const frame = await until('Inspector webview', () =>
      document.querySelector('iframe[data-extension-view="acme.docker.panel"]'),
    )
    assert(
      frame.sandbox.contains('allow-scripts') && !frame.sandbox.contains('allow-same-origin'),
      'view is not sandboxed',
    )
    const result = await smoke.executeExtensionCommand('acme.docker.sandboxProbe')
    assert(
      result.parentDenied &&
        result.tauriAbsent &&
        result.invokeRejected &&
        result.fileEscapeRejected &&
        result.foreignCommandRejected,
      `sandbox probe failed: ${JSON.stringify(result)}`,
    )
    // The probe forged postMessage IPC writes; give them time to land, then make sure none did.
    await new Promise((r) => setTimeout(r, 500))
    const stored = await smoke.extensionStorageGet('acme.docker')
    assert(
      !stored.forged,
      `forged IPC from the sandbox reached a command (${result.forgedTransports} transports)`,
    )
    // Repeated runs reuse one session and never take the dock away from the user.
    state().setActiveSession(sid)
    await smoke.executeExtensionCommand('acme.docker.refresh').catch(() => {})
    await smoke.executeExtensionCommand('acme.docker.refresh').catch(() => {})
    const runs = Object.values(state().runtimeTerminals).filter(
      (t) => t.extensionId === 'acme.docker',
    )
    assert(runs.length === 1, `terminals.run left ${runs.length} sessions`)
    assert(state().activeSession === sid, 'terminals.run stole the active terminal')
    const oldHost = document.querySelector('iframe[data-extension-host="acme.docker"]')
    await smoke.refreshExtensions(await smoke.reloadExtensions())
    await until('host replaced after reload', () => {
      const host = document.querySelector('iframe[data-extension-host="acme.docker"]')
      return host && host !== oldHost
    })
    await until('view restored after reload', () => state().extensionViews['acme.docker.panel'])
    const again = await smoke.executeExtensionCommand('acme.docker.sandboxProbe')
    assert(
      again.parentDenied && again.tauriAbsent && again.invokeRejected,
      'reloaded host lost isolation',
    )
    const reloadedHost = document.querySelector('iframe[data-extension-host="acme.docker"]')
    state().loadProject({ ...state().toProject(), name: 'switched project' })
    assert(
      document.querySelector('iframe[data-extension-host="acme.docker"]') === reloadedHost,
      'Reopening the same project replaced its host',
    )
    await until(
      'badge retained after reopening',
      () => state().extensionBadges[component.id]?.length,
    )
    await smoke.terminalReset()
    await smoke.report(
      'PASS extensions: manifest, device, detector, palette session, context, badge, Inspector view, IPC sandbox, forged IPC, run reuse',
    )
  } catch (error) {
    await smoke.report(`FAIL extensions: ${error.message}; app: ${state().message}`)
  }
})()
