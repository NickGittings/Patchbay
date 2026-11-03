;(async () => {
  const component = new URLSearchParams(location.search).get('component')
  const until = async (name, check) => {
    const end = Date.now() + 15000
    while (Date.now() < end) {
      const result = await check()
      if (result) return result
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const button = (label, root = document) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
  const smoke = await until('smoke', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  let unlisten
  try {
    if (component !== null) {
      await until('pop-out project', () => state().nodes.find((n) => n.id === component))
      await until('pop-out service', () => state().serviceConnected)
      await smoke.startTerminal(component, 'auth-wrapper', null)
      const setup = await until('pop-out setup', () =>
        document.querySelector('.provider-setup-overlay'),
      )
      const sid = smoke.sessionId(component, 'auth-wrapper', null)
      assert(!state().sessions[sid]?.running, 'pop-out launched before setup')
      await until('pop-out Continue anyway', () => {
        const b = button('Continue anyway', setup)
        return b && !b.disabled && b
      }).then((b) => b.click())
      await smoke.startTerminal(component, 'auth-wrapper', null)
      await until('explicit pop-out retry', () =>
        smoke.terminalText(sid).text.includes('popout-auth-started'),
      )
      await smoke.report(
        'PASS auth: both provider embedded logins, cancellation, drafts preserved, no automatic launch, independent hooks, private output, pop-out setup and explicit wrapper continuation',
      )
      return
    }
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    await until('service', () => state().serviceConnected && !state().restoring)
    const base = opened.project.root.replace(/\/project$/, '')
    let loginId
    let loginExited = false
    unlisten = await smoke.onProviderLoginEvent((e) => {
      if (
        e.type === 'output' &&
        new TextDecoder().decode(new Uint8Array(e.data)).includes('fixture-login-ready')
      )
        loginId = e.sessionId.split('/').at(-1)
      if (e.type === 'exited') loginExited = true
    })
    const before = state().rootTerminals.length
    const canary = 'Preserve my draft and selected components'
    smoke.simpleUi.getState().patch(smoke.simpleKey(opened.id, null), { draft: canary })
    for (const provider of ['claude', 'codex']) {
      const command = `env ${provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'}='${base}/config/${provider}' '${base}/${provider}'`
      const device = {
        id: provider,
        name: provider,
        command,
        kind: 'agent',
        adapter: provider,
        category: 'agent',
        source: 'user',
      }
      const checked = await smoke.providerAuthCheck({ provider, terminal: device }, true)
      assert(checked.state === 'signedOut', `${provider}: expected signed out`)
      assert(
        !JSON.stringify(checked).includes('never-persist-auth-output'),
        'raw status output escaped',
      )
      await smoke.startTaskAgent(device).catch(() => {})
      const dialog = await until('provider setup', () =>
        document.querySelector('.provider-setup-overlay'),
      )
      assert(
        dialog.textContent.includes(provider === 'claude' ? 'Claude Code' : 'Codex'),
        'wrong provider',
      )
      assert(
        state().rootTerminals.length === before + (provider === 'codex' ? 1 : 0),
        'blocked start changed terminals',
      )
      assert(
        smoke.simpleUi.getState().worktrees[smoke.simpleKey(opened.id, null)].draft === canary,
        'draft lost',
      )
      await until('Sign in enabled', () => {
        const b = button('Sign in', dialog)
        return b && !b.disabled && b
      }).then((b) => b.click())
      await until('embedded login terminal', () => dialog.querySelector('.xterm'))
      await until('login output', () => loginId)
      assert(
        (await smoke.sessionsList()).length === (provider === 'codex' ? 1 : 0),
        'login leaked to session history',
      )
      if (provider === 'claude') {
        button('Back to my work', dialog).click()
        await until('canceled login', () => loginExited)
        assert(
          (await smoke.providerAuthCheck({ provider, terminal: device }, true)).state ===
            'signedOut',
          'cancel completed login',
        )
        await smoke.startTaskAgent(device).catch(() => {})
        const retry = await until('retry setup', () =>
          document.querySelector('.provider-setup-overlay'),
        )
        loginId = undefined
        await until('retry sign in', () => {
          const b = button('Sign in', retry)
          return b && !b.disabled && b
        }).then((b) => b.click())
        await until('retry login output', () => loginId)
      }
      await smoke.providerLoginWrite(loginId, 'complete\n')
      await until('return to work', () => !document.querySelector('.provider-setup-overlay'))
      assert(
        state().rootTerminals.length === before + (provider === 'codex' ? 1 : 0),
        'login automatically added an agent',
      )
      await smoke.startTaskAgent(device)
      await until('agent starts on second click', async () =>
        (await smoke.sessionsList()).some((r) => r.metadata.name === provider),
      )
      const record = (await smoke.sessionsList()).find((r) => r.metadata.name === provider)
      assert(!JSON.stringify(record).includes('never-persist-auth-output'), 'auth output persisted')
      loginId = undefined
    }
    smoke.rail.setState({ settings: 'integrations' })
    await until('provider settings', () => document.querySelector('[aria-label="Agent providers"]'))
    assert(
      document.body.textContent.includes('Authentication:') &&
        document.body.textContent.includes('Install status hooks'),
      'auth and hooks not separate',
    )
    smoke.rail.setState({ settings: null })
    state().addComponent({ x: 0, y: 0 })
    const node = state().nodes.at(-1)
    state().updateComponent(node.id, {
      terminals: [
        {
          id: 'auth-wrapper',
          name: 'Auth wrapper',
          kind: 'agent',
          adapter: 'codex',
          command: 'printf popout-auth-started',
        },
      ],
    })
    await smoke.syncCurrentRoots()
    await smoke.openComponentWindow(node.id)
  } catch (e) {
    await smoke.report(`FAIL auth: ${e.message}; ${state().message}`)
  } finally {
    unlisten?.()
  }
})()
