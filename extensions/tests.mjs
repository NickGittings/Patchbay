// Deterministic first-party behavior checks. No Docker daemon, browser, or user storage needed.
import assert from 'node:assert/strict'
import * as docker from './docker/extension.js'
import * as preview from './preview/extension.js'
const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture() {
  const commands = new Map(),
    callbacks = new Map(),
    storage = new Map(),
    launches = [],
    opens = []
  let html = '',
    handler
  const component = {
    id: 'web',
    name: 'Web',
    path: 'web folder',
    terminals: [],
  }
  const workspace = { projectId: 'project', taskId: 'task-a' }
  let result = {
    exitCode: 0,
    running: false,
    output: '{"Name":"web-1","State":"running","Health":"healthy"}',
  }
  let sessions = [{ urls: ['http://localhost:3037', 'file:///secret'] }]
  let listeners = 0
  const disposable = () => ({ ready: Promise.resolve(), dispose() {} })
  const on = (event, fn) => {
    callbacks.set(event, fn)
    listeners++
    return {
      ready: Promise.resolve(),
      dispose() {
        callbacks.delete(event)
        listeners--
      },
    }
  }
  const pb = {
    workspace: { get: async () => ({ ...workspace }) },
    project: {
      get: async () => ({ components: [component] }),
      onDidChange: (fn) => on('project', fn),
    },
    selection: { component, onDidChangeSelection: (fn) => on('selection', fn) },
    files: {
      read: async (name) => {
        if (!name.endsWith('/compose.yml')) throw new Error('Missing')
        return 'services: {}'
      },
    },
    terminals: {
      run: async (id, command) => {
        launches.push([id, command])
        return result instanceof Promise ? await result : result
      },
    },
    sessions: {
      list: async () => (sessions instanceof Promise ? await sessions : sessions),
    },
    urls: { open: async (url) => opens.push(url) },
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        assert(key.length <= 200)
        storage.set(key, value)
      },
    },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn)
        return disposable()
      },
    },
    badges: { registerProvider: () => disposable() },
    views: {
      registerWebviewView: (_, h) => {
        handler = h
        h.resolve({
          render: async (value) => {
            html = value
          },
        })
        return disposable()
      },
    },
    window: { showMessage: async () => {} },
  }
  return {
    pb,
    commands,
    callbacks,
    storage,
    launches,
    opens,
    workspace,
    component,
    get html() {
      return html
    },
    get handler() {
      return handler
    },
    get listeners() {
      return listeners
    },
    set result(value) {
      result = value
    },
    set sessions(value) {
      sessions = value
    },
  }
}
assert.notEqual(
  docker.composeProjectName({ projectId: 'p', taskId: 'a' }, 'web'),
  docker.composeProjectName({ projectId: 'p', taskId: 'b' }, 'web'),
)
assert.notEqual(
  docker.composeProjectName({ projectId: 'p' }, 'web'),
  docker.composeProjectName({ projectId: 'q' }, 'web'),
)
assert.deepEqual(docker.parseContainers('[]'), [])
assert.equal(docker.parseContainers('{"State":"running"}\n{"State":"exited"}').length, 2)
assert.throws(() => docker.parseContainers('Docker daemon unavailable'))
assert.throws(() => docker.parseContainers('[{}]'))
let f = fixture()
await docker.activate(f.pb)
assert.equal(f.launches.length, 0, 'activation must not start/query Docker')
await f.commands.get('patchbay.docker.refresh')()
assert.match(
  f.launches[0][1],
  /^docker compose --project-name patchbay-[a-f0-9]+-[a-f0-9]+ --file compose.yml ps --all --format json$/,
)
assert.match(f.html, /healthy/)
f.result = {
  exitCode: 127,
  output: 'docker: command not found',
  running: false,
}
await assert.rejects(f.commands.get('patchbay.docker.refresh')(), /command not found/)
assert.match(f.html, /Stale — last successful refresh/)
assert.match(f.html, /web-1/, 'failed query must retain successful containers')
f.result = { exitCode: 0, output: 'invalid', running: false }
await assert.rejects(f.commands.get('patchbay.docker.refresh')(), /Unexpected token|Docker/)
assert.match(f.html, /web-1/)
const before = f.launches.length
await f.handler.onMessage({
  action: 'down',
  key: JSON.stringify(['another-project', null, 'web']),
})
await new Promise((r) => setTimeout(r, 0))
assert.equal(f.launches.length, before, 'stale view action must not launch Down')
const pending = deferred()
f.result = pending.promise
const running = f.commands.get('patchbay.docker.refresh')()
await new Promise((r) => setTimeout(r, 0))
docker.deactivate()
pending.resolve({ exitCode: 0, output: '[]', running: false })
await running
assert.equal(f.listeners, 0)
assert.equal(preview.storageKey('x'.repeat(3000)).length < 200, true)
assert.throws(() => preview.validateUrl('javascript:alert(1)'))
assert.throws(() => preview.validateUrl('https://u:p@localhost/'))
f = fixture()
await preview.activate(f.pb)
assert.equal(f.launches.length, 0)
await f.commands.get('patchbay.preview.refresh')()
assert.match(f.html, /http:\/\/localhost:3037\//)
assert.doesNotMatch(f.html, /file:\/\/\/secret/)
const key = JSON.stringify(['project', 'task-a', 'web'])
await f.handler.onMessage({
  action: 'save',
  key,
  url: 'https://localhost:4000',
})
assert.equal(f.storage.size, 1)
await f.handler.onMessage({
  action: 'open',
  key,
  url: 'https://localhost:4000/',
})
assert.deepEqual(f.opens, ['https://localhost:4000/'])
f.workspace.taskId = 'task-b'
f.callbacks.get('project')()
await f.handler.onMessage({
  action: 'open',
  key,
  url: 'https://localhost:4000/',
})
assert.equal(f.opens.length, 1)
const delayed = deferred()
f.sessions = delayed.promise
const refresh = f.commands.get('patchbay.preview.refresh')()
await new Promise((r) => setTimeout(r, 0))
f.workspace.taskId = 'task-c'
f.callbacks.get('project')()
delayed.resolve([{ urls: ['http://old-task:3037'] }])
await refresh
assert.doesNotMatch(f.html, /old-task/)
preview.deactivate()
assert.equal(f.listeners, 0)
console.log(
  'PASS first-party extensions: scoped Compose commands, failure/stale retention, no auto-start, URL validation/storage, stale actions/results, disposal',
)
