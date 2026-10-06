let pb
let panel
let active = false
let epoch = 0
let disposables = []
let entries = []
let saved = []
let origin
let message = 'Use Refresh to list URLs from this component’s task terminals.'
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
export function validateUrl(value) {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw new Error('Enter an HTTP or HTTPS URL without credentials or whitespace')
  return url.href
}
export function storageKey(identity) {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < identity.length; i++) {
    a = Math.imul(a ^ identity.charCodeAt(i), 0x01000193) >>> 0
    b = Math.imul(b ^ identity.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  return `urls:${a.toString(16)}-${b.toString(16)}`
}
async function scope() {
  const component = pb.selection.component
  const workspace = await pb.workspace.get()
  if (!active || pb.selection.component?.id !== component?.id) return null
  return workspace && component
    ? {
        ...workspace,
        componentId: component.id,
        key: JSON.stringify([workspace.projectId, workspace.taskId ?? null, component.id]),
      }
    : null
}
async function matches(captured) {
  return active && captured && (await scope())?.key === captured.key
}
async function render() {
  if (!active || !panel) return
  const token = epoch
  const captured = await scope()
  if (!active || !panel || token !== epoch) return
  const urls = [...new Set([...entries, ...saved])]
  await panel.render(
    `<style>body{font:14px system-ui;color:#ddd;background:#20232a;padding:12px}button{margin:4px;padding:6px}input{width:90%}</style><h3>Browser previews</h3><p>${escape(message)}</p><ul>${urls.map((url, i) => `<li>${escape(url)} <button data-open="${i}">Open</button>${saved.includes(url) ? `<button data-remove="${i}">Remove saved</button>` : ''}</li>`).join('')}</ul><button id="refresh">Refresh</button><p><input id="url" placeholder="https://localhost:3000" aria-label="Saved preview URL" /><button id="save">Save URL</button></p><p>Opening a URL uses your browser. Start the server separately in a task terminal.</p><script>const key=${JSON.stringify(captured?.key ?? null).replace(/</g, '\\u003c')};const urls=${JSON.stringify(urls).replace(/</g, '\\u003c')};document.querySelector('#refresh').onclick=()=>patchbayView.postMessage({action:'refresh',key});document.querySelector('#save').onclick=()=>patchbayView.postMessage({action:'save',key,url:document.querySelector('#url').value});document.querySelectorAll('[data-open]').forEach(b=>b.onclick=()=>patchbayView.postMessage({action:'open',key,url:urls[Number(b.dataset.open)]}));document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>patchbayView.postMessage({action:'remove',key,url:urls[Number(b.dataset.remove)]}));</script>`,
  )
}
async function refresh() {
  const token = ++epoch
  const captured = await scope()
  if (!captured) {
    entries = []
    saved = []
    message = 'Select a component first.'
    await render()
    return []
  }
  origin = captured
  try {
    const [sessions, stored] = await Promise.all([
      pb.sessions.list(captured.componentId),
      pb.storage.get(storageKey(captured.key)),
    ])
    if (token !== epoch || !(await matches(captured))) return []
    entries = [
      ...new Set(
        sessions
          .flatMap((session) => session.urls ?? [])
          .map((url) => {
            try {
              return validateUrl(url)
            } catch {
              return null
            }
          })
          .filter(Boolean),
      ),
    ]
    saved = Array.isArray(stored)
      ? stored
          .map((url) => {
            try {
              return validateUrl(url)
            } catch {
              return null
            }
          })
          .filter(Boolean)
      : []
    message = `${entries.length} terminal URL(s). Refreshed ${new Date().toLocaleTimeString()}.`
    await render()
    return entries
  } catch (error) {
    if (token === epoch && (await matches(captured))) {
      message = `Refresh failed: ${error}`
      await render()
    }
    throw error
  }
}
async function onMessage(value) {
  let captured
  const token = epoch
  try {
    captured = await scope()
    if (!captured || value?.key !== captured.key) return
    if (value?.action === 'refresh') return await refresh()
    if (!captured) throw new Error('Select a component first')
    if (!origin || origin.key !== captured.key)
      throw new Error('Workspace changed; Refresh before using these URLs')
    const url = validateUrl(value?.url)
    if (value.action === 'open') {
      if (![...entries, ...saved].includes(url))
        throw new Error('Refresh before opening this preview')
      return await pb.urls.open(url)
    }
    if (value.action === 'save' || value.action === 'remove') {
      const next =
        value.action === 'save'
          ? [...new Set([...saved, url])]
          : saved.filter((entry) => entry !== url)
      if (next.length > 50) throw new Error('At most 50 saved URLs per component/workspace')
      await pb.storage.set(storageKey(captured.key), next)
      if (!(await matches(captured))) return
      saved = next
      message = 'Saved URLs updated.'
      await render()
    }
  } catch (error) {
    if (token === epoch && (await matches(captured))) {
      message = String(error)
      await render()
    }
  }
}
function clear() {
  epoch++
  origin = undefined
  entries = []
  saved = []
  message = 'Workspace or selection changed. Use Refresh to load its URLs.'
  void render()
}
export async function activate(patchbay) {
  pb = patchbay
  active = true
  disposables.push(
    pb.views.registerWebviewView('patchbay.preview.panel', {
      resolve(view) {
        panel = view
        void render()
      },
      onMessage,
    }),
  )
  disposables.push(
    pb.commands.registerCommand('patchbay.preview.refresh', refresh),
    pb.selection.onDidChangeSelection(clear),
    pb.project.onDidChange(clear),
  )
  await Promise.all(disposables.map((d) => d.ready))
}
export function deactivate() {
  active = false
  epoch++
  for (const disposable of disposables) disposable.dispose()
  disposables = []
  entries = []
  saved = []
  origin = undefined
  panel = undefined
}
