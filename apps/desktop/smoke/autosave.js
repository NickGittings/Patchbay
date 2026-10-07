// Map saving through real toolbar/menu controls and fingerprint-checked native writes.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 20000
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
  const status = () => document.querySelector('.map-save-status .menu-trigger')
  const choose = async (text, inStatus = true) => {
    const trigger = inStatus
      ? status()
      : Array.from(document.querySelectorAll('.toolbar .menu-trigger')).find((b) =>
          b.textContent.trim().startsWith('Project'),
        )
    trigger.click()
    const button = await until(text, () =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) =>
        b.textContent.trim().startsWith(text),
      ),
    )
    assert(!button.disabled, `${text} unexpectedly disabled`)
    button.click()
  }
  try {
    await until('restoration', () => !s().restoring)
    const one = await smoke.openProject()
    smoke.acceptOpened(one)
    await until('unsaved status', () => status()?.textContent.includes('Map not saved'))
    const component = s().nodes[0].id
    s().updateComponent(component, { notes: 'Before creation' })
    await sleep(1000)
    assert((await smoke.openProject()).detected, 'Opening/editing must not create patchbay.json')
    await choose('Create map configuration', false)
    await until('first save', () => !s().dirty)
    assert(!(await smoke.openProject()).detected, 'Explicit creation did not write the map')
    await until('saved status', () => status()?.textContent.includes('Map saved'))
    s().updateComponent(component, { notes: 'Saved on inactive tab' })
    const two = await smoke.openSecondProject()
    smoke.acceptOpened(two)
    const secondComponent = s().nodes[0].id
    s().updateComponent(secondComponent, { notes: 'Second draft' })
    await until('inactive save', () => !s().captureProjects()[one.id].state.dirty)
    assert(s().dirty, 'Inactive save cleaned the active tab')
    assert((await smoke.openSecondProject()).detected, 'Second config created automatically')
    smoke.store.getState().activateProject(one.id)
    assert(
      (await smoke.openProject()).project.components.find((c) => c.id === component).notes ===
        'Saved on inactive tab',
      'Inactive map edit was not persisted',
    )
    const external = {
      ...s().toProject(),
      components: s()
        .toProject()
        .components.map((c) => ({ ...c, notes: 'External edit' })),
    }
    await smoke.saveProject(external, null)
    s().updateComponent(component, { notes: 'Local conflict' })
    await until('conflict status', () => status()?.textContent.includes('Map changed externally'))
    assert(
      (await smoke.openProject()).project.components[0].notes === 'External edit',
      'Autosave overwrote an external edit',
    )
    await choose('Reload saved map')
    await until('reload', () => !s().dirty && s().nodes[0].data.notes === 'External edit')
    await smoke.saveProject({ ...s().toProject(), name: 'Changed externally again' }, null)
    s().updateComponent(component, { notes: 'Explicit replacement' })
    await until('second conflict', () => status()?.textContent.includes('Map changed externally'))
    await choose('Replace with my map')
    await until('replacement', () => !s().dirty)
    assert(
      (await smoke.openProject()).project.components[0].notes === 'Explicit replacement',
      'Explicit replacement did not save',
    )
    s().updateComponent(component, { notes: 'Flushed without debounce' })
    assert(await smoke.flushMapSaves(one.id), 'Flush failed')
    assert(
      (await smoke.openProject()).project.components[0].notes === 'Flushed without debounce',
      'Flush did not persist latest map',
    )
    await smoke.report(
      'PASS autosave: explicit creation, status/menu controls, inactive edits, conflict reload/replacement and flush',
    )
  } catch (error) {
    await smoke.report(`FAIL autosave: ${error?.message ?? error}`)
  }
})()
