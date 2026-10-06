// Native broker and retained host coverage; Docker absence/failure is a valid explicit result.
;(async () => {
  if (new URLSearchParams(location.search).has('component')) return
  const until = async (name, check, timeout = 20000) => {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await check()
      if (value) return value
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`timed out waiting for ${name}`)
  }
  const assert = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const smoke = await until('smoke hooks', () => window.__patchbaySmoke)
  const state = () => smoke.store.getState()
  const denied = async (fn, name) => {
    let rejected = false
    try {
      await fn()
    } catch {
      rejected = true
    }
    assert(rejected, `${name} was allowed`)
  }
  try {
    const opened = await smoke.openProject()
    state().loadProject({
      ...opened.project,
      components: [
        {
          id: 'web',
          name: 'Web',
          kind: 'service',
          path: '.',
          notes: '',
          position: { x: 0, y: 0 },
          terminals: [
            {
              id: 'dev',
              name: 'Dev',
              kind: 'task',
              command: 'printf "Preview: http://localhost:3037\\ncwd:%s\\n" "$PWD"; exec cat',
            },
          ],
        },
      ],
      links: [],
    })
    await smoke.syncCurrentRoots()
    state().select('web')
    await smoke.refreshTasks()
    const project = state().toProject(),
      projectId = project.projectId
    await smoke.executeExtensionCommand('patchbay.preview.refresh')
    assert((await smoke.sessionsList()).length === 0, 'preview refresh started a server')
    await smoke.startTerminal('web', 'dev', null)
    const sid = smoke.sessionId('web', 'dev', null, projectId)
    await until('reported URL', () =>
      smoke.terminalText(sid).text.includes('http://localhost:3037'),
    )
    const summaries = await smoke.extensionSessionsList('patchbay.preview', project, 'web')
    assert(
      summaries.length === 1 && summaries[0].urls.includes('http://localhost:3037/'),
      'native summary omitted terminal URL',
    )
    assert(
      !('output' in summaries[0]) && !('data' in summaries[0]),
      'summary exposed terminal content',
    )
    await denied(
      () => smoke.extensionSessionsList('patchbay.docker', project, 'web'),
      'sessions permission',
    )
    await denied(
      () => smoke.extensionUrlOpen('patchbay.docker', projectId, 'http://localhost:3037'),
      'URL permission',
    )
    await denied(
      () => smoke.extensionUrlOpen('patchbay.preview', projectId, 'file:///tmp/private'),
      'URL protocol',
    )
    await denied(
      () => smoke.extensionUrlOpen('patchbay.preview', projectId, 'https://user:secret@localhost/'),
      'URL credentials',
    )
    const mainHost = await until('main Docker host', () =>
      document.querySelector('iframe[data-extension-host="patchbay.docker"]'),
    )
    const task = await smoke.createTask({
      title: 'Integration task',
      branch: 'smoke/integration',
      components: ['web'],
    })
    await until(
      'separate task host',
      () => document.querySelectorAll('iframe[data-extension-host="patchbay.docker"]').length === 2,
    )
    const run = await smoke.extensionTerminalRun(
      project,
      'patchbay.docker',
      'web',
      'printf "cwd:%s\\n" "$PWD"',
      'scope',
      task.id,
    )
    await until('task extension terminal cwd', () =>
      smoke.terminalText(run).text.replace(/\s+/g, '').includes(task.worktree.replace(/\s+/g, '')),
    )
    const record = (await smoke.sessionsList()).find((r) => r.id === run)
    assert(
      record.metadata.task === task.id && record.spec.cwd.includes(task.worktree),
      'extension launch escaped task worktree',
    )
    assert(
      (await smoke.extensionSessionsList('patchbay.preview', project, 'web', task.id)).every(
        (s) => s.sessionId !== sid,
      ),
      'main URL leaked to task',
    )
    await smoke.executeExtensionCommand('patchbay.docker.refresh').catch(() => {})
    const taskQuery = (await smoke.sessionsList()).find(
      (r) =>
        r.metadata.extensionId === 'patchbay.docker' &&
        r.metadata.command.startsWith('docker compose '),
    )
    assert(
      taskQuery?.metadata.task === task.id && taskQuery.spec.cwd.includes(task.worktree),
      'sandboxed Docker command did not retain its task',
    )
    await smoke.executeExtensionCommand('patchbay.preview.refresh')
    assert(
      !state().extensionViews['patchbay.preview.panel']?.includes('http://localhost:3037'),
      'preview view leaked the main task URL',
    )
    const text = await smoke.extensionFileRead('patchbay.docker', 'scope.txt', projectId, task.id)
    assert(text.trim() === 'main', 'task file read failed')
    state().setActiveTask(null)
    await until('retained main host', () => document.body.contains(mainHost))
    assert(state().sessions[sid]?.running, 'task switch stopped main server')
    await smoke.executeExtensionCommand('patchbay.docker.refresh').catch(() => {})
    const html = state().extensionViews['patchbay.docker.panel']
    assert(
      /Last successful refresh|Docker command failed|still running/.test(html),
      'Docker failure/query state was not explicit',
    )
    await smoke.terminalReset()
    await smoke.report(
      'PASS integrations: user-driven preview, native summaries and permission/URL denial, task worktree launches/reads, separate retained hosts, explicit Docker state',
    )
  } catch (error) {
    await smoke.report(`FAIL integrations: ${error.message}; app: ${state().message}`)
  }
})()
