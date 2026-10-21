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
  const reviewerTrigger = (root) => root.querySelector('.reviewer-picker > button')
  const escape = (el) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  try {
    await until('restore', () => !state().restoring && state().serviceConnected)
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    // Auto offers its settings only on a branch other than the default one.
    const onBranch = async (projectId) => {
      const task = await smoke.taskCreate(
        { title: 'Reviewers', branch: 'reviewers', components: [] },
        projectId,
      )
      await smoke.refreshTasks(projectId)
      state().setActiveTask(task.id)
      assert(state().activeTask === task.id, `project did not switch to ${task.branch}`)
    }
    await onBranch(two.id)
    state().setAgentRoles({ plan: ['a'], review: ['a', 'removed'] })
    state().activateProject(one.id)
    await onBranch(one.id)
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
    await until('first project defaults', () =>
      reviewerTrigger(autoAgents() ?? document)?.textContent.includes('a'),
    )
    assert(!autoAgents().querySelector('input'), 'Reviewer checkboxes are visible while closed')
    const trigger = reviewerTrigger(autoAgents())
    trigger.click()
    await until('reviewer dropdown focused', () =>
      document.activeElement?.matches('.reviewer-options input'),
    )
    await until('first project reviewer', () => checked() === 'a')
    autoAgents().querySelector('input[value="b"]').click()
    await until('parallel reviewers selected', () => checked() === 'a,b')
    assert(
      trigger.textContent.includes('2 agents selected'),
      'Multiple reviewer summary is missing',
    )
    escape(document.activeElement)
    await until('reviewer dropdown closed', () => trigger.getAttribute('aria-expanded') === 'false')
    assert(
      document.activeElement === trigger,
      'Escape did not return focus to the reviewer selector',
    )
    assert(autoAgents(), 'Escape closed the enclosing Auto panel')
    trigger.click()
    await until('reviewer dropdown reopened', () => checked() === 'a,b')
    roleSelect('Plan').value = 'b'
    roleSelect('Plan').dispatchEvent(new Event('change', { bubbles: true }))
    autoAgents().querySelector('input[value="a"]').click()
    await until('single reviewer selected', () => checked() === 'b')
    autoAgents().querySelector('input[value="b"]').click()
    await until('cleared reviewers', () => checked() === '')
    assert(trigger.textContent.includes('Select reviewers'), 'Empty reviewer prompt is missing')
    assert(
      [...document.querySelectorAll('.auto-content button')].find((b) => b.textContent === 'Start')
        ?.disabled,
      'Auto can start without a reviewer',
    )
    autoAgents().querySelector('input[value="b"]').click()
    await until(
      'first project overrides',
      () => roleSelect('Plan').value === 'b' && checked() === 'b',
    )
    const popover = document.querySelector('.auto-popover')
    popover.style.width = '260px'
    await sleep(100)
    assert(
      autoAgents().scrollWidth <= autoAgents().clientWidth + 1,
      'Reviewer selector overflows a narrow Auto panel',
    )
    assert(
      autoAgents().querySelector('input').getBoundingClientRect().width < 24,
      'Reviewer checkbox stretches across the row',
    )
    popover.style.removeProperty('width')
    roleSelect('Plan').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await until(
      'outside click closes reviewers',
      () => trigger.getAttribute('aria-expanded') === 'false',
    )
    assert(autoAgents(), 'An outside click within Auto closed the enclosing panel')
    state().activateProject(two.id)
    await until(
      'second project defaults',
      () =>
        autoAgents() &&
        roleSelect('Plan').value === 'a' &&
        reviewerTrigger(autoAgents()).textContent.includes('a'),
    )
    reviewerTrigger(autoAgents()).click()
    await until('second project reviewer', () => checked() === 'a')
    autoButton.click()
    // The saved missing reviewer remains removable, even with only one installed agent.
    smoke.store.setState({ devices: state().devices.slice(0, 1) })
    const toolsMenu = await until('Tools menu', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.startsWith('Tools')),
    )
    toolsMenu.click()
    const rolesButton = await until('Agent roles menu', () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent === 'Agent roles'),
    )
    rolesButton.click()
    const panel = await until('Agent roles panel', () =>
      document.querySelector('[aria-label="Agent roles"]'),
    )
    const roleTrigger = reviewerTrigger(panel)
    assert(
      roleTrigger.textContent.includes('2 agents selected'),
      'Saved reviewer summary is missing',
    )
    roleTrigger.click()
    await until('saved reviewers opened', () => panel.querySelector('.reviewer-options input'))
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
    panel.querySelector('.reviewer-options input[value="a"]').click()
    await until('default reviewers restored', () => !state().agentRoles.review)
    assert(roleTrigger.textContent.includes('Default:'), 'Project default summary is missing')
    panel.querySelector('.reviewer-options input[value="a"]').click()
    await until('reviewer saved', () => state().agentRoles.review?.join(',') === 'a')
    escape(document.activeElement)
    await until(
      'roles dropdown closed',
      () => roleTrigger.getAttribute('aria-expanded') === 'false',
    )
    assert(document.activeElement === roleTrigger, 'Roles dropdown did not restore focus')
    assert(panel.isConnected, 'Closing reviewers closed the Agent roles dialog')
    await smoke.report(
      'PASS reviewers: multi-select dropdowns preserve parallel reviews, defaults and overrides; focus, dismissal, narrow layout and missing presets work',
    )
  } catch (e) {
    await smoke.report(`FAIL reviewers: ${e.message ?? e} ${e.stack ?? ''}`)
  }
})()
