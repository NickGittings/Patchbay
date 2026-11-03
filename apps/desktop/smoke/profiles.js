;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check) => {
    const end = Date.now() + 20000
    while (Date.now() < end) {
      const value = await check()
      if (value) return value
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timed out waiting for ${name}`)
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const smoke = await until('smoke', () => window.__patchbaySmoke)
  try {
    smoke.rail.setState({ settings: 'profiles' })
    await until('profiles dialog', () => document.querySelector('[aria-label="Agent profiles"]'))
    const profile = await smoke.saveAgentProfile({
      id: '',
      name: 'Smoke router',
      executable: '/bin/sh',
      configDir: '',
      model: 'anthropic/example',
      openRouter: true,
      environment: { EXAMPLE: '' },
      credential: null,
      credentialEnv: 'PATCHBAY_SMOKE_ROUTER_KEY',
      archived: false,
    })
    assert(profile.configDir.includes(profile.id), 'config directory is not isolated')
    assert(profile.credential === null, 'environment key was stored in profile')
    const profiles = await smoke.listAgentProfiles()
    assert(profiles.length === 1, 'profile was not persisted')
    assert(!JSON.stringify(profiles).includes('smoke-fixture-only'), 'credential leaked')
    smoke.rail.setState({ settings: null })
    await until('closed dialog', () => !document.querySelector('[aria-label="Agent profiles"]'))
    smoke.rail.setState({ settings: 'profiles' })
    const select = await until('saved profile option', () => {
      const element = document.querySelector('[aria-label="Agent profiles"] select')
      return element && [...element.options].some((o) => o.value === profile.id) && element
    })
    select.value = profile.id
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const save = await until('save button', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save profile'),
    )
    save.click()
    await until('saved settings', () =>
      document.querySelector('[role="status"]')?.textContent.includes('Saved.'),
    )
    const installed = await smoke.agentHooksConfigure(
      'claude',
      true,
      `${profile.configDir}/settings.json`,
    )
    assert(installed.installed, 'isolated hooks were not installed')
    const checked = await smoke.agentHooksCheck('claude', `${profile.configDir}/settings.json`)
    assert(checked.installed, 'isolated hooks were not found')
    await smoke.saveAgentProfile({ ...profile, archived: true })
    assert((await smoke.listAgentProfiles())[0].archived, 'profile was not archived')
    smoke.report('PASS agent profiles settings, persistence and isolated hooks')
  } catch (e) {
    smoke.report(`FAIL ${e?.message ?? e}`)
  }
})()
