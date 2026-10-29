// Story board → trusted planner briefing → implementation worktree.
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, check, timeout = 15000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const value = await check()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const query = (selector) => document.querySelector(selector)
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const click = (el) => {
    if (!el) throw new Error('missing click target')
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const button = (selector, title) =>
    [...document.querySelectorAll(`${selector} button`)].find((b) => b.textContent.trim() === title)
  const edit = (el, value) => {
    if (!el) throw new Error('missing form control')
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  }
  const field = (name) =>
    [...document.querySelectorAll('.story-editor label')]
      .find((l) => l.firstChild?.textContent === name)
      ?.querySelector('input, textarea, select')
  try {
    const opened = await smoke.openProject()
    state().loadProject(opened.project)
    state().setSimpleMode(false)
    await smoke.resizeWindow(1600, 1000)
    await until('project components', () => state().nodes.length)
    const component = state().nodes[0]
    const projectId = state().project.id
    const fake = {
      id: 'smoke-story',
      name: 'Story planner',
      kind: 'agent',
      category: 'agent',
      source: 'builtin',
      command:
        'cat "$PATCHBAY_CONTEXT_FILE"; if [ -n "$PATCHBAY_PLAN_FILE" ]; then printf "# Story implementation\\nBuild the story and verify acceptance." > "$PATCHBAY_PLAN_FILE"; fi; printf "story-agent-ready\\n"; exec cat',
    }
    state().setDevices([fake])
    state().setAgentRoles({ plan: [fake.id], implement: [fake.id] })
    click(
      await until('component on map', () => query(`.react-flow__node[data-id="${component.id}"]`)),
    )
    await until('component selected', () => state().selectedId === component.id)
    state().onNodesChange([{ id: component.id, type: 'select', selected: true }])
    const nodeIds = state()
      .nodes.map((n) => n.id)
      .join()
    const wasDirty = state().dirty
    const viewport = query('.react-flow__viewport')?.style.transform
    const mapNode = query(`.react-flow__node[data-id="${component.id}"]`)
    const mapNodeVisible = () =>
      mapNode.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    await until('map component visible', mapNodeVisible)
    click(await until('Stories toggle', () => button('.navigation-map .view-tabs', 'Stories')))
    await until('story board', () => query('[aria-label="Story board"]'))
    assert(!mapNodeVisible(), 'map component is still visible over Stories')
    assert(mapNode.getClientRects().length === 0, 'hidden map node still participates in layout')
    const boardBounds = query('[aria-label="Story board"]').getBoundingClientRect()
    assert(
      !document
        .elementFromPoint(boardBounds.x + boardBounds.width / 2, boardBounds.y + 30)
        ?.closest('.navigation-map'),
      'hidden map intercepts story board input',
    )
    assert(
      state().selectedId === null && state().view === 'navigation',
      'board became a fifth view',
    )
    assert(state().dirty === wasDirty, 'board toggle dirtied the map')
    // The map stays mounted; its global deletion shortcut must be disabled here.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }),
    )
    await sleep(200)
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', bubbles: true }),
    )
    await sleep(100)
    assert(
      state()
        .nodes.map((n) => n.id)
        .join() === nodeIds,
      'hidden canvas deleted components',
    )
    const create = async (kind, title, parent) => {
      click(query(`[aria-label="Add ${kind}"]`))
      await until(
        'editor',
        () => query('.story-editor h3')?.textContent === `New ${kind}` && field('Title'),
      )
      assert(!query('.story-editor .story-status'), 'new draft shows derived progress')
      assert(field('Status'), 'new draft lost its Status select')
      edit(field('Title'), title)
      if (parent) edit(field(kind === 'feature' ? 'Epic' : 'Feature'), parent)
      if (kind === 'story') {
        edit(field('Description'), 'As a user, I can shape work before planning it.')
        click(button('.story-editor', '+ Add criterion'))
        edit(
          await until('acceptance input', () => query('[aria-label="Acceptance criterion 1"]')),
          'The board retains my story',
        )
        click(button('.story-editor .scope-chips', component.data.name))
      }
      await until('save enabled', () => {
        const save = button('.story-editor', 'Save')
        return save && !save.disabled
      })
      await sleep(50)
      click(button('.story-editor', 'Save'))
      return until(`${kind} saved`, () => state().stories.find((s) => s.title === title))
    }
    const epic = await create('epic', 'Story smoke epic')
    const feature = await create('feature', 'Story smoke feature', epic.id)
    const story = await create('story', 'Story smoke story', feature.id)
    await until('unlinked editor status', () => field('Status')?.value === 'backlog')
    assert(!query('.story-editor .story-status'), 'unlinked story shows a second status')
    const chooseCard = (title) =>
      click(
        [...document.querySelectorAll('.story-card')].find((b) => b.textContent.includes(title)),
      )
    const removeSelected = async (item) => {
      chooseCard(item.title)
      click(await until('Delete story button', () => button('.story-editor', 'Delete…')))
      click(await until('Confirm story deletion', () => button('.story-delete', 'Delete')))
      await until('story removed', () => !state().stories.some((s) => s.id === item.id))
    }
    const saveSelected = async () => {
      const before = state().stories
      click(button('.story-editor', 'Save'))
      await until(
        'story save complete',
        () => state().stories !== before && !button('.story-editor', 'Save')?.disabled,
      )
    }
    const { storyCreate, storyRemove, storyCompleteAuto, storyList } =
      await import('/src/lib/ipc.ts')
    const { updateStory, refreshStories, completeAutoStories } = await import('/src/lib/stories.ts')
    const savedStory = () => state().stories.find((s) => s.id === story.id)
    // A saved intermediate status agrees on the card and in the editor.
    edit(field('Status'), 'building')
    click(button('.story-editor', 'Save'))
    await until(
      'saved building remains editable',
      () =>
        savedStory().status === 'building' &&
        field('Status')?.value === 'building' &&
        query('.story-card.selected .story-status.building'),
    )
    edit(field('Status'), 'done')
    await saveSelected()
    click(await until('Reopen saved Building', () => button('.story-editor', 'Reopen')))
    await until(
      'Reopen restores Building consistently',
      () =>
        savedStory().status === 'building' &&
        field('Status')?.value === 'building' &&
        query('.story-card.selected .story-status.building'),
    )
    edit(field('Status'), 'backlog')
    click(button('.story-editor', 'Save'))
    await until('saved building cleared', () => savedStory().status === 'backlog')
    edit(field('Status'), 'planned')
    click(button('.story-editor', 'Save'))
    await until('planned saved', () => savedStory().status === 'planned')
    edit(field('Status'), 'done')
    click(button('.story-editor', 'Save'))
    await until('manual completion saved', () => savedStory().status === 'done')
    click(query('[aria-label="Close story editor"]'))
    chooseCard(story.title)
    click(await until('Reopen after reopening editor', () => button('.story-editor', 'Reopen')))
    await until(
      'Reopen restores planned',
      () => savedStory().status === 'planned' && field('Status')?.value === 'planned',
    )
    // An unsaved choice remains visible and survives a temporary child rollup.
    const statusEpic = await create('epic', 'Status regression epic')
    edit(field('Status'), 'done')
    const statusFeature = await storyCreate(projectId, {
      kind: 'feature',
      title: 'Status regression feature',
      parent: statusEpic.id,
    })
    await refreshStories(projectId)
    await until(
      'children take over status',
      () => !field('Status') && query('.story-editor .story-status.backlog'),
    )
    assert(
      query('.story-status-draft')?.textContent.includes('Unsaved status: done'),
      'child rollup silently discarded the unsaved status',
    )
    await saveSelected()
    assert(
      state().stories.find((s) => s.id === statusEpic.id).status === 'backlog',
      'Save wrote a hidden dropdown choice after children took over',
    )
    await updateStory(projectId, statusFeature.id, { parent: epic.id })
    await until('child rollup ends without losing choice', () => field('Status')?.value === 'done')
    await updateStory(projectId, statusFeature.id, { parent: statusEpic.id })
    await updateStory(projectId, statusFeature.id, { status: 'done' })
    await until(
      'done children allow explicit completion',
      () => query('.story-editor .story-status.done') && button('.story-editor', 'Mark done'),
    )
    click(button('.story-editor', 'Mark done'))
    await until(
      'parent explicitly completed',
      () => state().stories.find((s) => s.id === statusEpic.id).status === 'done',
    )
    await storyRemove(projectId, statusFeature.id, true)
    await refreshStories(projectId)
    await until(
      'parent completion survives child cleanup',
      () => query('.story-editor .story-status.done') && button('.story-editor', 'Reopen'),
    )
    await removeSelected(statusEpic)
    const temporaryFeature = await create('feature', 'Temporary feature', epic.id)
    await removeSelected(temporaryFeature)
    const unassigned = await create('story', 'Unassigned regression')
    assert(unassigned.parent === null, 'Add story retained a deleted feature id')
    const temporaryEpic = await create('epic', 'Temporary epic')
    await removeSelected(temporaryEpic)
    const fallbackFeature = await create('feature', 'Fallback feature regression')
    assert(fallbackFeature.parent === epic.id, 'Add feature retained a deleted epic id')
    assert(
      story.acceptance[0] === 'The board retains my story' &&
        story.components.join() === component.id,
      `story fields were lost: ${JSON.stringify(story)}`,
    )
    assert(
      smoke.workspaceDocument().projects.find((p) => p.id === projectId).layout.storyBoard === true,
      'board mode was not saved in layout',
    )
    // Map toggles retain the mounted React Flow instance and viewport.
    click(button('.story-board-header', 'Map'))
    await until('map visible', () => !state().storyBoard)
    await until('map component visible again', mapNodeVisible)
    assert(
      query(`.react-flow__node[data-id="${component.id}"]`) === mapNode,
      'toggle remounted the map component',
    )
    assert(
      query('.react-flow__viewport')?.style.transform === viewport,
      'toggle changed the map viewport',
    )
    // Chat mode shows the board in place of its map, keeping the chat open.
    state().setSimpleMode(true)
    click(await until('Chat Stories toggle', () => button('.navigation-map .view-tabs', 'Stories')))
    await until('board beside chat', () => query('.story-board'))
    assert(state().simpleMode && state().view === 'navigation', 'Stories left Chat mode')
    click(button('.story-board-header', 'Map'))
    await until('Chat map visible', () => !state().storyBoard && mapNodeVisible())
    state().setSimpleMode(false)
    click(button('.navigation-map .view-tabs', 'Stories'))
    await until('board restored', () => query('.story-board'))
    click(
      [...document.querySelectorAll('.story-card')].find((b) =>
        b.textContent.includes(story.title),
      ),
    )
    click(await until('Plan story button', () => button('.story-editor', 'Plan →')))
    const sid = smoke.sessionId('@plan', fake.id, null)
    await until('planner ready', () => smoke.terminalText(sid).text.includes('story-agent-ready'))
    assert(state().view === 'plan', 'Plan did not switch views')
    assert(state().highlighted.join() === component.id, 'Plan did not replace highlights')
    const text = smoke.terminalText(sid).text
    for (const part of [
      '## Story',
      epic.title,
      feature.title,
      story.title,
      '- [ ] The board retains my story',
      `Components: ${component.id}`,
    ])
      assert(text.includes(part), `briefing lacks ${part}`)
    await until(
      'Planned status',
      () => state().stories.find((s) => s.id === story.id)?.status === 'planned',
    )
    assert(
      state().planStory === story.id && state().planStoryTerminal === fake.id,
      'story Restart context was not retained',
    )
    // A plain start begins general planning and clears the pending story.
    await smoke.terminalStop(sid)
    await until('planner stopped', () => !state().sessions[sid]?.running)
    await smoke.startTerminal('@plan', fake.id, null, projectId)
    assert(
      state().planStory === null && state().planStoryTerminal === null,
      'plain planner start retained the old story',
    )
    state().setView('navigation')
    await until('board for worktree creation', () => query('.story-board'))
    chooseCard(story.title)
    click(await until('New worktree story action', () => button('.story-editor', 'New worktree')))
    await until('story worktree dialog', () => state().newTask?.title === story.title)
    const task = await smoke.createTask({
      title: 'Story smoke build',
      branch: 'story-smoke-build',
      components: [component.id],
    })
    state().setNewTask(null)
    // A temporary worktree link retains a pending choice without saving it.
    chooseCard(unassigned.title)
    await until('unassigned editor before worktree linkage', () => field('Status'))
    edit(field('Status'), 'done')
    await updateStory(projectId, unassigned.id, { task: task.id })
    await until(
      'worktree takes over status',
      () => !field('Status') && query('.story-editor .story-status.building'),
    )
    await saveSelected()
    assert(
      state().stories.find((s) => s.id === unassigned.id).status === 'backlog',
      'Save wrote a hidden dropdown choice after worktree linkage',
    )
    await updateStory(projectId, unassigned.id, { task: '' })
    await until('worktree removal restores choice', () => field('Status')?.value === 'done')
    edit(field('Status'), 'backlog')
    await saveSelected()
    // Persisted Auto completion can be reopened without the old run completing it again.
    await updateStory(projectId, unassigned.id, {
      task: task.id,
      autoRunId: 'smoke-completed-run',
      status: 'planned',
    })
    await completeAutoStories(projectId, task.id, 'smoke-completed-run')
    click(await until('Reopen completed Auto story', () => button('.story-editor', 'Reopen')))
    await until('Auto identity cleared on Reopen', () => {
      const item = state().stories.find((s) => s.id === unassigned.id)
      return item.status === 'planned' && !item.autoRunId
    })
    await refreshStories(projectId)
    // Call IPC directly so the frontend identity guard cannot make this pass vacuously.
    const staleCompletion = await storyCompleteAuto(projectId, task.id, 'smoke-completed-run')
    assert(!staleCompletion.length, 'backend accepted an old Auto completion after Reopen')
    assert(
      (await storyList(projectId)).find((s) => s.id === unassigned.id).status === 'planned',
      'old Auto run completed the reopened story again',
    )
    // An unfinished run in a background worktree must survive manual Done -> Reopen.
    const pendingRun = {
      runId: 'smoke-unfinished-run',
      status: 'paused',
      stage: 'build',
      goal: 'Finish the story',
      effort: 'standard',
      device: fake.id,
      round: 0,
      log: [],
      merge: { mode: 'ask', destinationBranch: 'main' },
    }
    state().setActiveTask(null)
    state().patchTask(projectId, task.id, { auto: pendingRun })
    await updateStory(projectId, unassigned.id, { autoRunId: pendingRun.runId })
    click(await until('Mark done with unfinished Auto', () => button('.story-editor', 'Mark done')))
    click(await until('Reopen with unfinished Auto', () => button('.story-editor', 'Reopen')))
    await until('unfinished Auto link preserved', () => {
      const item = state().stories.find((s) => s.id === unassigned.id)
      return item.status === 'planned' && item.autoRunId === pendingRun.runId
    })
    await completeAutoStories(projectId, task.id, pendingRun.runId)
    assert(
      state().stories.find((s) => s.id === unassigned.id).status === 'done',
      'unfinished Auto run could not complete the reopened story',
    )
    state().patchTask(projectId, task.id, { auto: null })
    state().setActiveTask(task.id)
    chooseCard(story.title)

    await until(
      'story linked at worktree creation',
      () => state().stories.find((s) => s.id === story.id)?.task === task.id,
    )
    state().setView('plan')
    click(
      await until('Implement in worktree', () =>
        [...document.querySelectorAll('.plan-implement button')].find((b) =>
          b.textContent.includes('Implement in'),
        ),
      ),
    )
    await until(
      'story linked to implementation',
      () => state().stories.find((s) => s.id === story.id)?.task === task.id,
    )
    await until('implementation session recorded', async () => {
      await smoke.reconcileSessions()
      return state().sessionRecords.some(
        (r) => r.metadata.task === task.id && r.metadata.componentId === '@task',
      )
    })
    state().setView('navigation')
    await until('board after Plan', () => query('.story-board'))
    await until('Building card', () =>
      [...document.querySelectorAll('.story-card')].find(
        (b) =>
          b.textContent.includes(story.title) &&
          b.textContent.includes('building') &&
          b.textContent.includes(task.title),
      ),
    )
    chooseCard(story.title)
    await until(
      'Building editor progress',
      () =>
        query('.story-editor .story-status.building') &&
        !field('Status') &&
        query('.story-editor .story-hint')?.textContent.includes(
          `Following worktree ${task.title}`,
        ),
    )
    const rootRecord = state().sessionRecords.find((r) => r.metadata.task === task.id)
    assert(rootRecord, 'missing implementation session record')
    smoke.store.setState({
      sessionRecords: [
        ...state().sessionRecords,
        {
          ...rootRecord,
          id: 'story-review-record',
          metadata: { ...rootRecord.metadata, componentId: '@review', branch: task.branch },
          spec: { ...rootRecord.spec, cwd: task.worktree },
          snapshot: { ...rootRecord.snapshot, startedMs: Date.now() + 1 },
        },
      ],
    })
    await until('Review card', () =>
      [...document.querySelectorAll('.story-card')].find(
        (b) =>
          b.textContent.includes(story.title) &&
          b.querySelector('.story-status.reviewing')?.textContent === 'review',
      ),
    )
    await until(
      'Review editor progress',
      () => query('.story-editor .story-status.reviewing')?.textContent === 'review',
    )
    chooseCard(feature.title)
    await until(
      'rolled-up editor progress',
      () =>
        query('.story-editor .story-status.reviewing')?.textContent === 'review' &&
        !field('Status') &&
        query('.story-editor .story-hint')?.textContent.includes('Following child progress'),
    )
    click(
      [...document.querySelectorAll('.story-card')].find((b) =>
        b.textContent.includes(story.title),
      ),
    )
    await until('story editor after rollup', () => field('Title')?.value === story.title)
    click(await until('Auto story button', () => button('.story-editor', 'Auto…')))
    const goal = await until('Auto goal prefilled', () => {
      const el = query('.auto-content textarea')
      return el?.value.includes('The board retains my story') && el
    })
    assert(
      goal.value.includes(story.title) && goal.value.includes(story.description),
      'Auto lost the story title or description',
    )
    click(button('.story-editor', 'Mark done'))
    await until(
      'saved Done overrides worktree progress',
      () =>
        query('.story-card.selected .story-status.done') &&
        query('.story-editor .story-status.done') &&
        !field('Status') &&
        button('.story-editor', 'Reopen'),
    )
    click(button('.story-editor', 'Reopen'))
    await until(
      'reopening resumes worktree status',
      () =>
        query('.story-card.selected .story-status.reviewing') &&
        query('.story-editor .story-status.reviewing') &&
        button('.story-editor', 'Mark done'),
    )
    // Exercise the real merge poll on a separate worktree, including repeated old outcomes.
    const mergeTask = await smoke.taskCreate({
      title: 'Story reopen merge',
      branch: 'story-reopen-merge',
      components: [],
    })
    await smoke.refreshTasks()
    const mergeStory = await storyCreate(projectId, {
      kind: 'story',
      title: 'Merged reopen regression',
    })
    await refreshStories(projectId)
    await updateStory(projectId, mergeStory.id, { task: mergeTask.id, status: 'planned' })
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
    state().setActiveTask(mergeTask.id)
    await smoke.startTerminal('@task', 'shell', mergeTask.id, projectId)
    const mergeSid = smoke.sessionId('@task', 'shell', mergeTask.id)
    await smoke.terminalWrite(
      mergeSid,
      `git -C ${quote(mergeTask.worktree)} -c user.name=Smoke -c user.email=smoke@example.com -c commit.gpgsign=false commit --allow-empty -qm 'Story work' && ` +
        `git -C ${quote(opened.project.root)} -c merge.gpgsign=false merge --ff-only ${quote(mergeTask.branch)} && ` +
        'printf "\\nstory-merge-ready\\n"\r',
    )
    await until('real story merge', () =>
      smoke.terminalText(mergeSid).text.includes('\nstory-merge-ready\n'),
    )
    const destination = (await smoke.gitWorktrees(projectId)).find(
      (w) => w.path === opened.project.root,
    )
    await smoke.reconcileSessions()
    const mergeRecord = state().sessionRecords.find((r) => r.id === mergeSid)
    assert(mergeRecord, 'missing merge fixture session')
    smoke.store.setState({
      sessionRecords: [
        ...state().sessionRecords,
        {
          ...mergeRecord,
          id: 'story-reopen-merge-record',
          metadata: { ...mergeRecord.metadata, componentId: '@merge' },
          spec: { ...mergeRecord.spec, cwd: destination.path, merge_source: mergeTask.worktree },
        },
      ],
    })
    const { storyProgressPoll } = await import('/src/lib/storyProgress.ts')
    const progressPoll = storyProgressPoll(projectId)
    try {
      await progressPoll.poll()
      await until(
        'merged story saved Done',
        () => state().stories.find((s) => s.id === mergeStory.id).status === 'done',
      )
      // Clear the board filters so the new unassigned story is selectable.
      click(button('.story-column', 'All epics'))
      click(
        await until('merged story card', () =>
          [...document.querySelectorAll('.story-card')].find((b) =>
            b.textContent.includes(mergeStory.title),
          ),
        ),
      )
      click(await until('Reopen merged story', () => button('.story-editor', 'Reopen')))
      await until(
        'merged story reopened',
        () => state().stories.find((s) => s.id === mergeStory.id).status === 'planned',
      )
      for (let i = 0; i < 2; i++) {
        smoke.store.setState({ gitChanges: {} })
        await progressPoll.poll()
        const outcome = await smoke.mergeOutcome(state().toProject(), {
          source: mergeTask.worktree,
          sourceBranch: mergeTask.branch,
          destination: destination.path,
          destinationBranch: destination.branch,
        })
        assert(
          ['merged', 'alreadyIntegrated'].includes(outcome),
          'fixture branch is not integrated',
        )
        assert(
          (await storyList(projectId)).find((s) => s.id === mergeStory.id).status === 'planned',
          'merge poll completed the reopened story again',
        )
      }
    } finally {
      progressPoll.dispose()
    }
    click(button('.story-board-header', 'Map'))
    await until(
      'map returned',
      () => !state().storyBoard && query('.navigation-map:not(.story-map-hidden) .canvas'),
    )
    await smoke.report(
      'PASS stories: hierarchy creation, acceptance, component links, layout persistence, viewport, trusted planner briefing, Plan handoff, Building status, saved status editing, Reopen, retained status choices, child completion, running Auto linkage, stale Auto rejection, merged-branch Reopen, Auto goal, map visibility and toggle',
    )
  } catch (e) {
    await smoke.report(`FAIL stories: ${e?.message ?? e} ${e?.stack ?? ''}`)
  }
})()
