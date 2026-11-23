// Deterministic first-party behavior checks. No Docker daemon, browser, or user storage needed.
import assert from 'node:assert/strict'
import * as docker from './docker/extension.js'
import * as preview from './preview/extension.js'
import * as storyImport from './story-import/extension.js'
import * as github from './github-issues/extension.js'
import * as linear from './linear/extension.js'
import { readFileSync } from 'node:fs'
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

// Story import: the board's hierarchy rules, Jira-style CSV and Markdown outlines.
{
  const fixture = (name) =>
    readFileSync(
      new URL(`./story-import/fixture/${name}`, import.meta.url),
      "utf8",
    );
  const csv = storyImport.parseFile(
    "jira-export.csv",
    fixture("jira-export.csv"),
  );
  const byId = (items, id) => items.find((i) => i.externalId === id);
  assert.equal(byId(csv, "SHOP-1").kind, "epic");
  // A story directly under an epic goes under a feature named after it.
  assert.equal(byId(csv, "SHOP-2").parent, "SHOP-1/feature");
  assert.equal(byId(csv, "SHOP-1/feature").parent, "SHOP-1");
  assert.deepEqual(byId(csv, "SHOP-2").acceptance, [
    "A declined card shows the provider's message",
    "Successful payment empties the cart",
  ]);
  assert.equal(
    byId(csv, "SHOP-2").description,
    "Card payments, through the existing provider.",
  );
  assert.equal(byId(csv, "SHOP-3").kind, "story");
  assert.equal(byId(csv, "SHOP-3").title, 'Totals round "wrong"');
  const md = storyImport.parseFile("backlog.md", fixture("backlog.md"));
  assert.deepEqual(
    md.map((i) => [i.kind, i.externalId, i.parent]),
    [
      ["epic", "md:checkout", null],
      ["feature", "md:checkout/payments", "md:checkout"],
      ["story", "md:checkout/payments/pay-by-card", "md:checkout/payments"],
      [
        "story",
        "md:checkout/payments/pay-with-saved-card",
        "md:checkout/payments",
      ],
      ["feature", "md:checkout/receipts", "md:checkout"],
      ["story", "md:checkout/receipts/email-a-receipt", "md:checkout/receipts"],
    ],
  );
  assert.equal(
    md[2].description,
    "Card payments through the existing provider.",
  );
  assert.equal(md[2].acceptance.length, 2);
  const json = storyImport.parseFile(
    "items.json",
    JSON.stringify({
      items: [
        {
          title: "Loose feature",
          kind: "feature",
          children: [{ title: "Child", url: "javascript:x" }],
        },
      ],
    }),
  );
  assert.equal(
    json.find((i) => i.title === "Loose feature").parent,
    "file:epic",
  );
  assert.equal(json.find((i) => i.title === "Child").url, null);
  assert.throws(() => storyImport.parseFile("notes.txt", "x"));
  assert.throws(() => storyImport.parseCsv("Name\n".replace("Name", "Nope")));
  // Re-importing the same file produces the same ids.
  assert.deepEqual(
    storyImport.parseFile("backlog.md", fixture("backlog.md")),
    md,
  );

  const upserts = [];
  let run;
  await storyImport.activate({
    files: {
      pick: async () => ({ name: "backlog.md", text: fixture("backlog.md") }),
    },
    stories: {
      upsert: async (items) => (
        upserts.push(items),
        { created: items.length, updated: 0, unchanged: 0 }
      ),
    },
    window: { showMessage: async () => {} },
    commands: {
      registerCommand: (id, fn) => {
        assert.equal(id, "patchbay.story-import.import");
        run = fn;
        return { ready: Promise.resolve(), dispose() {} };
      },
    },
  });
  assert.equal((await run()).created, md.length);
  assert.deepEqual(upserts[0], md);
  storyImport.deactivate();
}

// GitHub Issues: mapping, pagination and authenticated requests through the broker.
{
  assert.equal(
    github.parseRepo("https://github.com/acme/shop.git"),
    "acme/shop",
  );
  assert.throws(() => github.parseRepo("acme"));
  assert.equal(github.apiBase(""), "https://api.github.com");
  assert.equal(
    github.apiBase("https://ghe.corp/api/v3/"),
    "https://ghe.corp/api/v3",
  );
  assert.throws(() => github.apiBase("http://ghe.corp/api/v3"));
  const items = github.toItems("acme/shop", [
    {
      number: 1,
      title: "Pay",
      body: "Text\n- [ ] Works\n- [x] Done",
      html_url: "https://github.com/acme/shop/issues/1",
      milestone: {
        number: 3,
        title: "v1",
        html_url: "https://github.com/acme/shop/milestone/3",
      },
    },
    { number: 2, title: "PR", pull_request: {} },
    { number: 4, title: "Loose", body: null },
  ]);
  assert.deepEqual(
    items.map((i) => [i.kind, i.externalId, i.parent ?? null]),
    [
      ["epic", "acme/shop", null],
      ["feature", "acme/shop/milestone/3", "acme/shop"],
      ["story", "acme/shop#1", "acme/shop/milestone/3"],
      ["story", "acme/shop#4", null],
    ],
  );
  assert.deepEqual(items[2].acceptance, ["Works", "Done"]);
  const requests = [];
  const http = {
    fetch: async (request) => {
      requests.push(request);
      return requests.length === 1
        ? {
            status: 200,
            headers: [
              [
                "link",
                '<https://api.github.com/repos/acme/shop/issues?page=2>; rel="next"',
              ],
            ],
            body: '[{"number":1,"title":"A"}]',
          }
        : { status: 200, headers: [], body: '[{"number":2,"title":"B"}]' };
    },
  };
  const issues = await github.fetchIssues(
    http,
    { repo: "acme/shop", labels: "ready" },
    true,
  );
  assert.equal(issues.length, 2);
  assert.match(
    requests[0].url,
    /^https:\/\/api\.github\.com\/repos\/acme\/shop\/issues\?state=open&per_page=100&labels=ready$/,
  );
  assert.deepEqual(requests[0].auth, { secret: "token", scheme: "bearer" });
  assert.equal(
    requests[1].url,
    "https://api.github.com/repos/acme/shop/issues?page=2",
  );
  await assert.rejects(
    github.fetchIssues(
      { fetch: async () => ({ status: 404, headers: [], body: "" }) },
      { repo: "a/b" },
      false,
    ),
    /wasn't found/,
  );
}

// Linear: initiative → epic, project → feature, cursor pagination, GraphQL errors.
{
  assert.equal(linear.parseTeam(" eng "), "ENG");
  assert.throws(() => linear.parseTeam("not a key"));
  const items = linear.toItems("ENG", [
    {
      id: "i1",
      identifier: "ENG-1",
      title: "Pay",
      description: "- [ ] Works",
      url: "https://linear.app/x/issue/ENG-1",
      project: {
        id: "p1",
        name: "Checkout",
        url: "https://linear.app/x/project/p1",
        initiatives: {
          nodes: [
            {
              id: "n1",
              name: "Revenue",
              url: "https://linear.app/x/initiative/n1",
            },
          ],
        },
      },
    },
    {
      id: "i2",
      identifier: "ENG-2",
      title: "Docs",
      project: { id: "p2", name: "Site", initiatives: { nodes: [] } },
    },
    { id: "i3", identifier: "ENG-3", title: "Loose", project: null },
  ]);
  assert.deepEqual(
    items.map((i) => [i.kind, i.externalId, i.parent ?? null]),
    [
      ["epic", "initiative:n1", null],
      ["epic", "team:ENG", null],
      ["feature", "project:p1", "initiative:n1"],
      ["feature", "project:p2", "team:ENG"],
      ["story", "ENG-1", "project:p1"],
      ["story", "ENG-2", "project:p2"],
      ["story", "ENG-3", null],
    ],
  );
  const bodies = [];
  const pages = [
    {
      data: {
        issues: {
          nodes: [{ id: "a" }],
          pageInfo: { hasNextPage: true, endCursor: "c1" },
        },
      },
    },
    {
      data: {
        issues: {
          nodes: [{ id: "b" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ];
  const http = {
    fetch: async (request) => {
      assert.equal(request.method, "POST");
      assert.deepEqual(request.auth, { secret: "apiKey", scheme: "raw" });
      bodies.push(JSON.parse(request.body));
      return {
        status: 200,
        headers: [],
        body: JSON.stringify(pages[bodies.length - 1]),
      };
    },
  };
  assert.equal((await linear.fetchIssues(http, "ENG", false)).length, 2);
  assert.equal(bodies[1].variables.after, "c1");
  assert.deepEqual(bodies[0].variables.closed, [
    "completed",
    "canceled",
    "duplicate",
  ]);
  await assert.rejects(
    linear.fetchIssues(
      {
        fetch: async () => ({
          status: 200,
          headers: [],
          body: '{"errors":[{"message":"Bad team"}]}',
        }),
      },
      "ENG",
      true,
    ),
    /Bad team/,
  );
}
console.log(
  "PASS integrations: story file import, GitHub Issues and Linear mapping and pagination",
);
