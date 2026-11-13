// Launched after chat-team.js using the same state and still-running session service.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (label, check) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await sleep(80)
    }
    throw new Error(`Timed out: ${label}`)
  }
  const assert = (value, message) => {
    if (!value) throw new Error(message)
  }
  const smoke = await until('hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  try {
    await until(
      'workspace restored',
      () => !state().restoring && state().project && state().serviceConnected,
    )
    state().setActiveTask(null)
    state().setSimpleMode(true)
    const projectId = state().project.id
    const team = () => smoke.chatTeams.getState().teams[projectId]?.find((t) => t.task === null)
    await until('team restored', () => team())
    const lead = team().lead.sessionId
    const generation = team().lead.generation
    assert(state().simple.selectedAgent === lead, 'Restart lost the selected lead')
    assert(team().state === 'stopped', 'Restart discarded explicit stop')
    assert(team().informationRequests[0].response, 'Restart lost the information response')
    assert(
      state().simple.log.some((e) => e.text === 'Continue without provider history'),
      'Restart lost chat history',
    )
    const input = await until('preserved draft', () => {
      const element = document.querySelector('[aria-label="Message agent"]')
      return element?.value === 'Draft preserved across app restart' && element
    })
    assert(input, 'Restart lost the draft')
    const submit = await until('send enabled', () =>
      [...document.querySelectorAll('button')].find(
        (b) => ['Send', 'Queue'].includes(b.textContent.trim()) && !b.disabled,
      ),
    )
    submit.click()
    await until('pending message delivered', () =>
      state().simple.log.some(
        (e) => e.kind === 'prompt' && e.text === 'Draft preserved across app restart',
      ),
    )
    assert(
      team().lead.sessionId === lead && team().lead.generation === generation,
      'Restart launched a duplicate lead',
    )
    assert(team().state === 'stopped', 'Lead messaging restarted scheduling')
    assert(
      state().simple.log.filter(
        (e) => e.kind === 'prompt' && e.text === 'Draft preserved across app restart',
      ).length === 1,
      'Restart duplicated the pending message',
    )
    await smoke.report(
      'PASS chat restart: transcript, draft, existing-agent response and explicit stop preserved; Send reconnects the same running lead once',
    )
  } catch (e) {
    await smoke.report(
      `FAIL chat restart: ${e.message} ${e.stack ?? ''} message=${state().message}`,
    )
  }
})()
