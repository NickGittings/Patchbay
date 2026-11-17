// Exercises the shared header in the desktop and a component pop-out with both offline providers.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await sleep(75)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const popout = new URLSearchParams(location.search).get('component')
  const state = () => smoke.store.getState()
  const button = (label) =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
  try {
    if (popout) {
      await until('pop-out New conversation', () => button('New conversation'))
      assert(document.querySelector('.agent-context'), 'Pop-out lacks context indicator')
      await smoke.report(
        'PASS conversation-context: Claude/Codex fresh launches, Chat question answers, confirmation, duplicate clicks, history, context, clear/compact, chained status-line, Auto guard, and pop-out controls',
      )
      return
    }
    await until('restore', () => !state().restoring && state().serviceConnected)
    await smoke.agentHooksConfigure('claude', true)
    await smoke.agentHooksConfigure('codex', true)
    await smoke.usageStatusLineConfigure(true)
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    state().setView('implementation')
    const id = state().nodes[0].id
    const base = opened.project.root.replace(/\/project$/, '')
    for (const provider of ['claude', 'codex']) {
      state().updateComponent(id, {
        terminals: [
          {
            id: 'context',
            name: 'Context fixture',
            kind: 'agent',
            command: `'${base}/${provider}'`,
          },
        ],
      })
      const sid = smoke.sessionId(id, 'context')
      const previous = state().sessions[sid]?.generation ?? -1
      await smoke.startTerminal(id, 'context')
      const agent = () => state().sessions[sid]?.status?.agent
      const context = () => state().sessions[sid]?.status?.context
      await until(
        'provider startup',
        () =>
          state().sessions[sid]?.running &&
          state().sessions[sid]?.generation > previous &&
          agent()?.state === 'idle',
      )
      await until('unavailable context header', () =>
        document.body.textContent.includes('Context unavailable'),
      )
      await smoke.terminalWrite(sid, 'prompt\rcontext\r')
      await until('context observation', () => context()?.usedPercent === 37)
      await until('context header', () =>
        document.querySelector('.agent-context')?.textContent.includes('37%'),
      )
      if (provider === 'claude') {
        await smoke.terminalWrite(sid, 'approval\r')
        await until('approval', () => agent()?.state === 'needsInput')
        await until('compacting indicator', () => document.body.textContent.includes('Compacting…'))
      }
      if (provider === 'codex') await smoke.terminalWrite(sid, 'compact\r')
      // The question tool's hook: unclaimed, the provider's own menu asks; claimed and
      // answered, the hook hands the answer back. Nothing is typed into the terminal.
      const questions = smoke.agentQuestions
      await questions.listen()
      const offered = () =>
        Object.values(questions.store.getState().pending).find((q) => q.sessionId === sid)
      const answered = (from) =>
        smoke
          .terminalText(sid)
          .text.slice(from)
          .match(/fixture-answer (.*)/)?.[1]
      let from = smoke.terminalText(sid).text.length
      await smoke.terminalWrite(sid, 'question\r')
      const first = await until('question offered', offered)
      assert(first.questions[0].options[1].label === 'Blue', 'Question lost its options')
      await until('unclaimed question falls back', () => answered(from) === 'none')
      from = smoke.terminalText(sid).text.length
      await smoke.terminalWrite(sid, 'question\r')
      const second = await until(
        'question offered again',
        () => offered()?.id !== first.id && offered(),
      )
      await questions.claim([sid])
      await until('question status', () => agent()?.questions?.[0]?.question === 'Pick a color')
      assert(await questions.answer(second.id, ['Blue']), 'Chat answer refused')
      // Claude takes the answer as its tool's own; Codex gets it as the declined call's reason.
      const expected = provider === 'claude' ? 'allow:Blue' : 'deny:Blue'
      const output = await until('hook answer', () => answered(from))
      assert(output.trim() === expected, `Hook answered ${output}, expected ${expected}`)
      await until('compaction completion', () => !!context()?.lastCompactionMs)
      assert(
        agent()?.state === (provider === 'claude' ? 'needsInput' : 'working'),
        'Compaction ended the turn',
      )
      await smoke.terminalWrite(sid, 'clear\rlate-stop\r')
      await until(
        'same-id clear',
        () => agent()?.state === 'idle' && context()?.usedPercent == null,
      )
      const generation = state().sessions[sid].generation
      const confirm = window.confirm
      const asked = []
      try {
        window.confirm = (message) => {
          asked.push(message)
          return false
        }
        button('New conversation').click()
        await sleep(100)
        assert(
          state().sessions[sid].generation === generation,
          'Cancelled confirmation replaced the run',
        )
        window.confirm = (message) => {
          asked.push(message)
          return true
        }
        const fresh = button('New conversation')
        fresh.click()
        fresh.click()
        await until(
          'new generation',
          () => state().sessions[sid]?.generation > generation && agent()?.state === 'idle',
        )
        await until(
          'fresh action settles',
          () => button('New conversation') && !button('New conversation').disabled,
        )
        assert(asked.length === 2, 'Duplicate click opened another confirmation')
        assert(
          asked[1] ===
            'Start a new conversation with the current Patchbay briefing? This stops the current agent. Saved history remains available.',
          'Confirmation changed',
        )
        assert(context()?.usedPercent == null, 'Fresh run inherited context usage')
        const record = (await smoke.sessionsList()).find((r) => r.id === sid)
        assert(record.history.length >= 1, 'Fresh run lost saved history')
        assert(!record.metadata.conversationPinned, 'Fresh run retained pinned resume identity')
        state().patchTask(opened.id, null, {
          auto: {
            runId: 'fixture',
            status: 'paused',
            sessionId: sid,
            stage: 'plan',
            goal: 'Fixture',
            effort: 'light',
            device: 'fixture',
            round: 0,
            log: [],
            merge: { mode: 'ask', destinationBranch: 'main' },
          },
        })
        await until('Auto disables New conversation', () => button('New conversation')?.disabled)
        state().patchTask(opened.id, null, { auto: null })
      } finally {
        window.confirm = confirm
      }
      if (provider === 'claude') {
        await smoke.terminalWrite(sid, 'context\r')
        await until('chained status-line output', () =>
          smoke.terminalText(sid).text.includes('chained-status-line'),
        )
      }
      await smoke.terminalStop(sid)
      await until('stopped fixture', () => !state().sessions[sid]?.running)
    }
    await smoke.openComponentWindow(id, 'Context fixture')
    // The pop-out reports PASS, which terminates this isolated smoke run.
  } catch (error) {
    await smoke.report(`FAIL conversation-context: ${error.message ?? error} ${error.stack ?? ''}`)
  }
})()
