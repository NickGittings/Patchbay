// Native hook setup and a real packaged reporter feeding an interactive fixture terminal.
;(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const until = async (name, check) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await sleep(50)
    }
    throw new Error(`Timed out: ${name}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  if (new URLSearchParams(location.search).has('component')) return
  const state = () => smoke.store.getState()
  const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
  try {
    await until('workspace restore', () => !state().restoring && state().serviceConnected)
    for (const provider of ['claude', 'codex']) {
      assert(
        !(await smoke.agentHooksCheck(provider)).installed,
        'Fixture starts with hooks installed',
      )
      await smoke.agentHooksConfigure(provider, true)
      await smoke.agentHooksConfigure(provider, true)
      const installed = await smoke.agentHooksCheck(provider)
      assert(
        installed.installed && installed.reporterAvailable,
        'Native setup did not install hooks/reporter',
      )
      assert(installed.reportingSessions === 0, 'Installation falsely confirmed reporting')
      await smoke.agentHooksConfigure(provider, false)
      await smoke.agentHooksConfigure(provider, false)
      assert(
        !(await smoke.agentHooksCheck(provider)).installed,
        'Removal left owned hooks installed',
      )
    }
    await smoke.agentHooksConfigure('codex', true)
    const integration = await smoke.agentHooksCheck('codex')
    const opened = await smoke.openProject()
    smoke.acceptOpened(opened)
    const id = state().nodes[0].id
    smoke.selectPanel('usage')
    await until('Usage panel', () => document.querySelector('[aria-label="Usage panel"]'))
    const pauseAuto = await until('Pause Auto control', () =>
      document.querySelector('.usage-controls input[type="checkbox"]'),
    )
    const previousSettings = state().usageSettings
    // Simulate a blur committing a threshold immediately before the checkbox's change event.
    state().setUsageSettings({ ...previousSettings, warnPercent: 75, pausePercent: 93 })
    pauseAuto.click()
    assert(
      state().usageSettings.warnPercent === 75 &&
        state().usageSettings.pausePercent === 93 &&
        state().usageSettings.gateAuto === !previousSettings.gateAuto,
      'Pause Auto overwrote a freshly committed threshold',
    )
    state().setUsageSettings(previousSettings)
    await until('capture action', () =>
      [...document.querySelectorAll('button')].find(
        (b) => b.textContent === 'Capture Claude usage',
      ),
    ).then((b) => b.click())
    await until('capture installed', async () => (await smoke.usageStatusLineCheck()).installed)
    const reset = Math.floor(Date.now() / 1000) + 7200
    const usageInput = JSON.stringify({
      rate_limits: {
        five_hour: { used_percentage: 96, resets_at: reset },
        seven_day: { used_percentage: 41, resets_at: reset + 86400 },
      },
    })
    const command = `printf '%s' ${quote(usageInput)} | ${quote(integration.reporter)} status-line; while IFS= read -r event; do printf '{"hook_event_name":"%s","session_id":"12345678-conversation","turn_id":"12345678-turn"}' "$event" | ${quote(integration.reporter)} report-status codex; done`
    state().updateComponent(id, {
      terminals: [
        { id: 'reporter', name: 'Status fixture', command, kind: 'agent', adapter: 'codex' },
      ],
    })
    await smoke.startTerminal(id, 'reporter')
    const sid = smoke.sessionId(id, 'reporter')
    await until(
      'captured Claude usage',
      async () => (await smoke.refreshUsage())?.claude?.fiveHour?.usedPercent === 96,
    )
    await until(
      'usage bars',
      () => document.querySelector('[aria-label="Claude 5-hour usage"]')?.value === 96,
    )
    assert(
      document.querySelector('[aria-label="Usage limit warning"]'),
      'Rail usage warning is missing',
    )
    assert(
      (await smoke.usageRead()).claude.weekly.usedPercent === 41,
      'Weekly Claude usage was not captured',
    )
    await until('usage warning toast', () =>
      state().notificationToast?.message?.includes('Claude 5-hour limit is 96% used'),
    )
    await smoke.usageStatusLineConfigure(false)
    assert(
      !(await smoke.usageStatusLineCheck()).installed,
      'Capture removal left the status line installed',
    )
    smoke.selectPanel(null)
    const agent = () => state().sessions[sid]?.status?.agent
    for (const [event, expected] of [
      ['UserPromptSubmit', 'working'],
      ['PermissionRequest', 'needsInput'],
      ['PostToolUse', 'working'],
    ]) {
      await smoke.terminalWrite(sid, `${event}\n`)
      await until(expected, () => agent()?.state === expected && agent()?.authoritative)
    }
    await sleep(16500)
    assert(agent()?.state === 'working', 'Quiet authoritative Working expired')
    const confirmed = await smoke.agentHooksCheck('codex')
    assert(confirmed.reportingSessions === 1, 'Live reporting was not confirmed')
    await smoke.terminalWrite(sid, 'SubagentStop\n')
    await sleep(300)
    assert(agent()?.state === 'working', 'Subagent completion ended the parent turn')
    await smoke.terminalWrite(sid, 'Stop\n')
    await until('ready for review', () => agent()?.state === 'review')
    await smoke.terminalWrite(sid, 'PostToolUse\n')
    await sleep(300)
    assert(agent()?.state === 'review', 'Late tool progress reopened a completed turn')
    await smoke.terminalWrite(sid, 'SessionEnd\n')
    await until('ended', () => agent()?.state === 'ended')
    // Open the actual setup dialog from Settings; native setup should match its visible status.
    state().setPaletteOpen(true)
    await until('integration command', () =>
      document.querySelector('[data-command-id="integrations"]'),
    ).then((b) => b.click())
    await until('integration dialog', () =>
      document.querySelector('[aria-label="Agent status integration"]'),
    )
    await until(
      'setup check',
      () => document.querySelector('[aria-label="User hook source"]')?.value,
    )
    assert(document.body.textContent.includes('Install status hooks'), 'Setup actions are missing')
    await smoke.stopTerminal(id, 'reporter')
    await smoke.agentHooksConfigure('codex', false)
    await smoke.report(
      'PASS status hooks: usage capture/panel/badge/warning/removal, native setup/removal, preserved existing sources, portable reporter, authoritative quiet work, permission/review/end, subagent and late-turn guards, setup UI',
    )
  } catch (error) {
    await smoke.report(`FAIL status hooks: ${error.message ?? error} ${error.stack ?? ''}`)
  }
})()
