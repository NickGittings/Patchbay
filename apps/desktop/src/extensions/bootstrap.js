// Runs in an opaque-origin frame. The only app transport is parent.postMessage.
;(() => {
  let next = 0
  const pending = new Map()
  const commands = new Map()
  const listeners = new Map()
  const providers = new Map()
  const views = new Map()
  // Longer than the host's own deadlines (`apiTimeout` in host.ts), so its error arrives first.
  const timeout = (method) =>
    method === 'files.pick' || method === 'secrets.prompt'
      ? 10 * 60000 + 5000
      : method === 'http.fetch'
        ? 45000
        : 35000
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Patchbay API timeout'))
      }, timeout(method))
      pending.set(id, { resolve, reject, timer })
      parent.postMessage({ patchbay: 1, id, method, args }, '*')
    })
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(fn)
    return { dispose: () => listeners.get(event)?.delete(fn), ready: Promise.resolve(null) }
  }
  const register = (map, key, fn, method) => {
    map.set(key, fn)
    const ready = call(method, key)
    ready.catch(() => map.delete(key))
    return {
      dispose: () => {
        map.delete(key)
        void call('dispose', method, key)
      },
      ready,
    }
  }
  const api = {
    commands: {
      registerCommand: (id, fn) => register(commands, id, fn, 'commands.register'),
      executeCommand: (id, ...args) => call('commands.execute', id, args),
    },
    project: { get: () => call('project.get'), onDidChange: (fn) => on('project', fn) },
    workspace: { get: () => call('workspace.get') },
    sessions: { list: (componentId) => call('sessions.list', componentId) },
    urls: { open: (url) => call('urls.open', url) },
    selection: { component: null, onDidChangeSelection: (fn) => on('selection', fn) },
    terminals: {
      start: (cid, tid) => call('terminals.start', cid, tid),
      run: (cid, command) => call('terminals.run', cid, command),
    },
    context: { registerProvider: (fn) => register(providers, 'context', fn, 'context.register') },
    badges: { registerProvider: (fn) => register(providers, 'badges', fn, 'badges.register') },
    views: {
      registerWebviewView: (id, handler) => {
        views.set(id, handler)
        const disposable = register(providers, id, () => null, 'views.register')
        handler.render = (html) => call('views.render', id, html)
        handler.postMessage = (message) => call('views.postMessage', id, message)
        handler.resolve?.(handler)
        return disposable
      },
    },
    window: { showMessage: (text) => call('window.showMessage', text) },
    storage: {
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
    },
    git: { status: () => call('git.status') },
    files: {
      read: (path) => call('files.read', path),
      pick: (options) => call('files.pick', options ?? {}),
    },
    stories: {
      list: () => call('stories.list'),
      // Messages to Patchbay are capped at 1 MiB, so large imports go in parent-first batches.
      upsert: async (items) => {
        const rank = { epic: 0, feature: 1, story: 2 }
        const sorted = [...items].sort((a, b) => (rank[a?.kind] ?? 3) - (rank[b?.kind] ?? 3))
        const total = { created: 0, updated: 0, unchanged: 0 }
        let batch = []
        let size = 0
        const flush = async () => {
          if (!batch.length) return
          const report = await call('stories.upsert', batch)
          for (const key of Object.keys(total)) total[key] += report?.[key] ?? 0
          batch = []
          size = 0
        }
        for (const item of sorted) {
          const length = JSON.stringify(item).length
          if (batch.length && (size + length > 512 * 1024 || batch.length >= 500)) await flush()
          batch.push(item)
          size += length
        }
        await flush()
        return total
      },
      onDidChange: (fn) => on('stories', fn),
    },
    http: { fetch: (request) => call('http.fetch', request) },
    secrets: {
      prompt: (name, options) => call('secrets.prompt', name, options ?? {}),
      has: (name) => call('secrets.has', name),
      delete: (name) => call('secrets.delete', name),
    },
  }
  window.patchbay = api
  addEventListener('message', async (event) => {
    if (event.source !== parent || event.data?.patchbay !== 1) return
    const message = event.data
    if (message.method === 'event') {
      if (message.event === 'selection') api.selection.component = message.value
      for (const fn of listeners.get(message.event) ?? []) {
        try {
          fn(message.value)
        } catch {
          /* isolate listeners */
        }
      }
      return
    }
    if (message.method === 'viewMessage') {
      views.get(message.viewId)?.onMessage?.(message.value)
      return
    }
    if (message.method === 'call') {
      try {
        const fn =
          message.target === 'command' ? commands.get(message.key) : providers.get(message.key)
        if (!fn) throw new Error('Provider is not registered')
        const result = await fn(...message.args)
        parent.postMessage({ patchbay: 1, reply: message.id, result }, '*')
      } catch (error) {
        parent.postMessage({ patchbay: 1, reply: message.id, error: String(error) }, '*')
      }
      return
    }
    if (message.method === 'deactivate') {
      try {
        await window.__patchbayDeactivate?.()
      } finally {
        parent.postMessage({ patchbay: 1, reply: message.id, result: null }, '*')
      }
      return
    }
    const request = pending.get(message.reply)
    if (request) {
      clearTimeout(request.timer)
      pending.delete(message.reply)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    }
  })
})()
