// Reviewed map maintenance in the real desktop webview and native broker.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (what, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const rejects = async (fn, message) => {
    let rejected = false
    try {
      await fn()
    } catch {
      rejected = true
    }
    assert(rejected, message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    const original = state().toProject()
    const originalWeb = original.components.find((c) => c.id === 'web')
    state().setEdgeLabel('unavailable', 'Edited detected label')
    assert(
      state()
        .toProject()
        .links.find((l) => l.id === 'unavailable').detection.detector ===
        'extension:disabled:links',
      'editing a detected link label must preserve provenance',
    )
    state().setEdgeLabel('unavailable', original.links.find((l) => l.id === 'unavailable').label)
    const issues = await smoke.mapIssues(original)
    for (const [id, kind] of [
      ['old', 'missing'],
      ['locked', 'locked'],
      ['unreadable', 'unreadable'],
    ])
      assert(
        issues.some((i) => i.componentId === id && i.kind === kind),
        `${id} issue must be ${kind}`,
      )

    state().select('mystery')
    await until('legacy provenance in Inspector', () =>
      document
        .querySelector('.inspector .maintenance-origin')
        ?.textContent.includes('Unclassified'),
    )
    const classify = Array.from(document.querySelectorAll('.inspector button')).find(
      (b) => b.textContent.trim() === 'Mark manual',
    )
    assert(classify, 'legacy classification action missing')
    classify.click()
    assert(
      state().nodes.find((n) => n.id === 'mystery').data.detection.detector === 'manual',
      'legacy classification must be explicit',
    )

    const stale = await smoke.rescanProject(state().toProject())
    state().updateComponent('web', { notes: 'Changed during scan' })
    await rejects(
      () => smoke.applyReconciliation(state().toProject(), stale.id, []),
      'outdated draft must reject preview',
    )
    state().updateComponent('web', { notes: originalWeb.notes })
    const accessStale = await smoke.rescanProject(state().toProject())
    await smoke.syncRoots(['web', 'api', 'changed-access'])
    await rejects(
      () => smoke.applyReconciliation(state().toProject(), accessStale.id, []),
      'changed access must reject preview',
    )
    await smoke.syncCurrentRoots()

    await smoke.startTerminal('api', 'shell')
    const running = smoke.sessionId('api', 'shell')
    await until('API running', () => state().sessions[running]?.running)
    assert(!(await smoke.removeComponents(['api'])), 'running component removal must be refused')
    assert(
      state().nodes.some((n) => n.id === 'api'),
      'refused removal must retain component',
    )
    assert(
      !(await smoke.repairComponentPath('api', 'web')),
      'running component path repair must be refused',
    )
    assert(
      state().nodes.find((n) => n.id === 'api').data.path === 'api',
      'refused repair must retain path',
    )
    await smoke.stopTerminal(running)
    await until('API stopped', () => !state().sessions[running]?.running)

    const task = await smoke.createTask({
      title: 'Reviewed map',
      branch: 'reviewed-map',
      components: ['web', 'mystery'],
    })
    state().setActiveTask(null)
    await smoke.reviewRescan()
    await until('review dialog', () => document.querySelector('[aria-label="Review map changes"]'))
    const preview = smoke.maintenance.getState().review.preview
    assert(
      [
        ...document.querySelectorAll('[aria-label="Review map changes"] input[type="checkbox"]'),
      ].filter((input) => input.checked).length ===
        preview.proposals.filter((p) => p.selected).length,
      'review selection defaults do not match safe proposals',
    )
    assert(!state().nodes.some((n) => n.id === 'new'), 'Rescan must leave draft unchanged')
    assert(
      preview.proposals.some(
        (p) =>
          p.change.kind === 'addLink' &&
          p.change.link.source === 'web' &&
          p.change.link.target === 'new',
      ),
      'existing-to-new dependency proposal missing',
    )
    assert(
      preview.proposals.some(
        (p) => p.change.kind === 'removeLink' && p.change.linkId === 'stale' && !p.selected,
      ),
      'stale links must start unselected',
    )
    assert(
      !preview.proposals.some(
        (p) => p.change.kind === 'removeLink' && p.change.linkId === 'unavailable',
      ),
      'unavailable detector cannot prove stale',
    )
    const move = preview.proposals.find(
      (p) => p.change.kind === 'moveComponent' && p.change.componentId === 'old',
    )
    assert(move && !move.selected, 'move repair must require review')
    await smoke.flushMapSaves()
    const beforeApply = await smoke.openProject()
    assert(
      !beforeApply.project.components.some((c) => c.id === 'new'),
      'Review must not persist proposed changes',
    )
    const selections = preview.proposals
      .filter(
        (p) =>
          p.selected ||
          p.id === move.id ||
          p.id === 'unlink:stale' ||
          p.id === 'remove:mystery' ||
          p.change.kind === 'addLink',
      )
      .map((p) => p.id)
    await smoke.applyMapReview(selections)
    assert(!smoke.maintenance.getState().review, `apply failed: ${state().message}`)
    const draft = state().toProject()
    assert(
      draft.components.some((c) => c.id === 'new'),
      'selected addition not applied',
    )
    assert(
      draft.components.find((c) => c.id === 'old').path === 'moved-new',
      'repair must retain original ID',
    )
    assert(
      draft.links.some((l) => l.source === 'old' && l.target === 'api'),
      'move dependencies must target retained ID',
    )
    assert(!draft.links.some((l) => l.id === 'stale'), 'selected stale removal not applied')
    assert(
      draft.links.find((l) => l.id === 'manual').label === 'User label',
      'manual label must survive',
    )
    assert(
      draft.links.some((l) => l.id === 'unavailable'),
      'unavailable detector link must survive',
    )
    assert(
      JSON.stringify(draft.components.find((c) => c.id === 'web')) === JSON.stringify(originalWeb),
      'user component configuration must survive',
    )
    assert(
      !draft.components.some((c) => c.id === 'mystery'),
      'selected missing removal not applied',
    )
    assert(!draft.groups[0].componentIds.includes('mystery'), 'group scope cleanup missing')
    assert(
      !state()
        .tasks.find((t) => t.id === task.id)
        .components.includes('mystery'),
      'task scope cleanup missing',
    )
    assert(state().dirty, 'Apply must leave a dirty draft')
    await until('applied map autosaved', () => !state().dirty)
    const freshOpened = await smoke.openProject()
    assert(
      freshOpened.project.schemaVersion === 4 &&
        freshOpened.project.components.some((c) => c.id === 'new'),
      'Approved changes must autosave to patchbay.json',
    )
    const second = await smoke.openSecondProject()
    smoke.acceptOpened(second)
    state().activateProject(original.projectId)
    const beforeRepair = state().toProject()
    const originAccessPreview = await smoke.rescanProject(beforeRepair)
    const repair = smoke.repairComponentPath('api', '.')
    state().activateProject(second.id)
    assert(await repair, 'originating workspace path repair failed')
    assert(
      state().nodes.find((n) => n.id === 'api').data.path === 'api',
      'delayed repair changed another workspace',
    )
    assert(
      state()
        .captureProjects()
        [original.projectId].state.nodes.find((n) => n.id === 'api').data.path === '.',
      'delayed repair did not update its originating workspace',
    )
    await rejects(
      () => smoke.applyReconciliation(beforeRepair, originAccessPreview.id, []),
      'inactive repair must update its native roots and invalidate old access previews',
    )
    await smoke.report(
      'PASS maintenance: reviewed additions/dependencies/removals/moves, legacy preservation, issue distinctions, access/draft revisions, stopped-session guards and scope cleanup',
    )
  } catch (e) {
    await smoke.report(`FAIL maintenance: ${e?.message ?? e}`)
  }
})()
