// First-party integration, running inside the same sandbox as third-party extensions.
const filenames = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
let disposables = []
let state = new Map()
let panel
let active = false
let pb
let renderEpoch = 0
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
const join = (folder, file) => (folder === '.' ? file : `${folder.replace(/\/$/, '')}/${file}`)

export function composeProjectName(scope, componentId) {
  // Component folders have the same basename in sibling task worktrees. An explicit
  // project name prevents one worktree's Down from stopping another worktree's containers.
  const identity = JSON.stringify([scope.projectId, scope.taskId ?? null, componentId])
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let i = 0; i < identity.length; i++) {
    first = Math.imul(first ^ identity.charCodeAt(i), 0x01000193) >>> 0
    second = Math.imul(second ^ identity.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `patchbay-${first.toString(16)}-${second.toString(16)}`
}
export function parseContainers(output) {
  const text = output.trim()
  if (!text) return []
  const rows = text.startsWith('[')
    ? JSON.parse(text)
    : text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((row) => JSON.parse(row))
  if (
    !Array.isArray(rows) ||
    rows.some((row) => !row || typeof row !== 'object' || typeof row.State !== 'string')
  )
    throw new Error('Docker returned an unrecognized container response')
  return rows.map((row) => ({
    name: String(row.Name ?? row.Service ?? row.ID ?? 'Container'),
    state: row.State,
    health: String(row.Health ?? ''),
  }))
}
async function capture() {
  const selectedId = pb.selection.component?.id
  const scope = await pb.workspace.get()
  const project = await pb.project.get()
  const component = project?.components.find((c) => c.id === selectedId)
  if (!scope || !component) throw new Error('Select a component first')
  let file
  for (const name of filenames) {
    try {
      await pb.files.read(join(component.path, name))
      file = name
      break
    } catch {
      /* Other allowed Compose filenames may exist. */
    }
  }
  if (!file)
    throw new Error(
      'No readable Compose file in this component. Choose a Compose component and check folder access.',
    )
  const key = JSON.stringify([scope.projectId, scope.taskId ?? null, component.id])
  if (!active || pb.selection.component?.id !== selectedId)
    throw new Error('Selection changed; choose the Docker action again')
  return { scope, component, file, key }
}
async function current(origin) {
  if (!active) return false
  const scope = await pb.workspace.get()
  return (
    scope?.projectId === origin.scope.projectId &&
    (scope?.taskId ?? null) === (origin.scope.taskId ?? null)
  )
}
async function render() {
  if (!panel || !active) return
  const token = ++renderEpoch
  const component = pb.selection.component
  const scope = await pb.workspace.get()
  if (!active || !scope || token !== renderEpoch || pb.selection.component?.id !== component?.id)
    return
  const key = JSON.stringify([scope.projectId, scope.taskId ?? null, component?.id])
  const result = state.get(key)
  const last = result?.last
  const status = result?.busy
    ? 'Command running…'
    : result?.error
      ? result.error
      : last
        ? `${last.containers.length} container(s)`
        : 'Not refreshed. Select a Compose component and use Refresh.'
  const rows =
    last?.containers
      .map(
        (row) =>
          `<li>${escape(row.name)}: ${escape(row.state)}${row.health ? ` (${escape(row.health)})` : ''}</li>`,
      )
      .join('') ?? ''
  const actions = ['refresh', 'up', 'down', 'logs']
    .map(
      (action) =>
        `<button ${result?.busy ? 'disabled' : ''} data-action="${action}">${action[0].toUpperCase() + action.slice(1)}</button>`,
    )
    .join(' ')
  await panel.render(
    `<style>body{font:14px system-ui;color:#ddd;background:#20232a;padding:12px}button{margin:4px;padding:6px} .error{color:#ffb878}</style><h3>${escape(component?.name ?? 'Docker Compose')}</h3><p class="${result?.error ? 'error' : ''}">${escape(status)}</p>${last ? `<p>${result?.stale ? 'Stale — last successful refresh' : 'Last successful refresh'}: ${escape(new Date(last.at).toLocaleString())}</p><ul>${rows}</ul>` : ''}${result?.logs ? `<pre>${escape(result.logs)}</pre>` : ''}${actions}<script>document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>patchbayView.postMessage({action:b.dataset.action,key:${JSON.stringify(key).replace(/</g, '\\u003c')}}))</script>`,
  )
}
async function run(action, expectedKey) {
  let origin
  try {
    origin = await capture()
    if (expectedKey && origin.key !== expectedKey) return
    const previous = state.get(origin.key) ?? {}
    if (previous.busy) throw new Error('A Docker command is still running in this component')
    state.set(origin.key, {
      ...previous,
      busy: true,
      error: '',
      stale: !!previous.last,
    })
    await render()
    const base = `docker compose --project-name ${composeProjectName(origin.scope, origin.component.id)} --file ${origin.file}`
    const suffix = {
      refresh: 'ps --all --format json',
      up: 'up -d',
      down: 'down',
      logs: 'logs --no-color --tail 200',
    }[action]
    const result = await pb.terminals.run(origin.component.id, `${base} ${suffix}`)
    if (!(await current(origin))) return result
    if (result.running)
      throw new Error('Docker command is still running; inspect its task terminal, then Refresh')
    if (result.exitCode !== 0)
      throw new Error(
        `Docker command failed${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}: ${result.output.trim() || 'Docker may be unavailable; check its task terminal'}`,
      )
    if (action === 'refresh')
      state.set(origin.key, {
        busy: false,
        stale: false,
        last: { at: Date.now(), containers: parseContainers(result.output) },
      })
    else
      state.set(origin.key, {
        ...previous,
        busy: false,
        stale: !!previous.last,
        logs: action === 'logs' ? result.output : previous.logs,
        error:
          action === 'logs'
            ? ''
            : `${action === 'up' ? 'Up' : 'Down'} finished. Refresh to update container state.`,
      })
    await render()
    return result
  } catch (error) {
    if (origin && (await current(origin))) {
      const previous = state.get(origin.key) ?? {}
      state.set(origin.key, {
        ...previous,
        busy: false,
        stale: !!previous.last,
        error: String(error),
      })
      await render()
    } else if (!origin && active) await pb.window.showMessage(String(error))
    throw error
  }
}
export async function activate(patchbay) {
  pb = patchbay
  active = true
  disposables.push(
    pb.views.registerWebviewView('patchbay.docker.panel', {
      resolve(view) {
        panel = view
        void render()
      },
      onMessage(value) {
        if (
          ['refresh', 'up', 'down', 'logs'].includes(value?.action) &&
          typeof value.key === 'string'
        )
          void run(value.action, value.key).catch(() => {})
      },
    }),
  )
  for (const action of ['refresh', 'up', 'down', 'logs'])
    disposables.push(pb.commands.registerCommand(`patchbay.docker.${action}`, () => run(action)))
  disposables.push(
    pb.project.onDidChange(() => void render()),
    pb.selection.onDidChangeSelection(() => void render()),
  )
  disposables.push(
    pb.badges.registerProvider(async (component) => {
      const scope = await pb.workspace.get()
      if (!active || !scope) return null
      const result = state.get(
        JSON.stringify([scope.projectId, scope.taskId ?? null, component.id]),
      )
      return result
        ? {
            text: result.error
              ? 'Docker error'
              : result.last
                ? `${result.last.containers.length} containers${result.stale ? ' · stale' : ''}`
                : 'Docker pending',
            tone: result.error ? 'warning' : 'info',
            tooltip:
              result.error ||
              (result.last
                ? `Last successful refresh: ${new Date(result.last.at).toLocaleString()}`
                : 'Use Refresh'),
          }
        : null
    }),
  )
  await Promise.all(disposables.map((d) => d.ready))
}
export function deactivate() {
  active = false
  renderEpoch++
  for (const disposable of disposables) disposable.dispose()
  disposables = []
  panel = undefined
  state = new Map()
}
