;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (ok, message) => {
    if (!ok) throw new Error(message)
  }
  const smoke = await until('smoke handles', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const autoAgents = () => document.querySelector('.auto-agents')
  const roleSelect = (label) =>
    [...autoAgents().querySelectorAll('label')]
      .find((el) => el.textContent.startsWith(label))
      ?.querySelector('select')
  const checked = () =>
    [...autoAgents().querySelectorAll('input:checked')].map((input) => input.value).join(',')
  try {
    await until('restore', () => !state().restoring && state().serviceConnected)
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    state().setAgentRoles({ plan: ['a'], review: ['a', 'removed'] })
    state().activateProject(one.id)
    state().setAgentRoles({ plan: ['a'], review: ['a'] })
    smoke.store.setState({
      devices: ['a', 'b'].map((id) => ({
        id,
        name: id,
        command: 'codex',
        adapter: 'codex',
        kind: 'agent',
        source: 'user',
        category: 'agent',
      })),
    })
    const autoButton = await until('Auto button', () =>
      document.querySelector('button[title="Auto mode"]'),
    )
    autoButton.click()
    await until('first project defaults', () => autoAgents() && checked() === 'a')
    roleSelect('Plan').value = 'b'
    roleSelect('Plan').dispatchEvent(new Event('change', { bubbles: true }))
    autoAgents().querySelector('input[value="a"]').click()
    await until('cleared reviewers', () => checked() === '')
    autoAgents().querySelector('input[value="b"]').click()
    await until(
      'first project overrides',
      () => roleSelect('Plan').value === 'b' && checked() === 'b',
    )
    state().activateProject(two.id)
    await until(
      'second project defaults',
      () => autoAgents() && roleSelect('Plan').value === 'a' && checked() === 'a',
    )
    autoButton.click()
    // The saved missing reviewer remains removable, even with only one installed agent.
    smoke.store.setState({ devices: state().devices.slice(0, 1) })
    const toolsMenu = await until('Tools menu', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Tools')),
    )
    toolsMenu.click()
    const rolesButton = await until('Agent roles menu', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Agent roles…'),
    )
    rolesButton.click()
    const panel = await until('Agent roles panel', () =>
      document.querySelector('[aria-label="Agent roles"]'),
    )
    const removed = [...panel.querySelectorAll('label')].find((el) =>
      el.textContent.includes('removed (not installed)'),
    )
    assert(removed, 'Missing reviewer has no removal control')
    assert(
      !panel.textContent.includes('These agents review independently'),
      'Missing presets inflate the reviewer hint',
    )
    removed.querySelector('input').click()
    await until('missing reviewer removed', () => state().agentRoles.review?.join(',') === 'a')
    await smoke.report(
      'PASS reviewers: Auto choices reset between projects; missing presets can be removed and do not inflate hints',
    )
  } catch (e) {
    await smoke.report(`FAIL reviewers: ${e.message ?? e} ${e.stack ?? ''}`)
  }
})()
