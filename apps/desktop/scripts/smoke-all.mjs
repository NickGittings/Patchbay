// Runs smoke scripts against one build and one Vite server instead of a `tauri dev` per script.
//   node scripts/smoke-all.mjs                  every script, then a summary
//   node scripts/smoke-all.mjs views git        just those (the `npm run smoke:*` entries)
//   node scripts/smoke-all.mjs --bail           stop at the first failure
//   node scripts/smoke-all.mjs --jobs 1         one script at a time, output streamed (default 3)
// Each script gets its own TMPDIR, so the fixed fixture paths under it never collide. With more
// than one job, a script's output goes to a log printed when it finishes; `serial` scripts run
// alone after the rest.
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { desktop, root } from './smoke-lib.mjs'
import { copySmokeProject } from './smoke-fixtures.mjs'
const require = createRequire(import.meta.url)
// A path inside the run's own TMPDIR, where the `smoke/*-fixture.sh` scripts put their repos
// (`${TMPDIR:-/tmp}`); resolved once each run has its folder.
const RUN_TMP = '<run-tmp>'
const tmp = (path) => `${RUN_TMP}/${path}`
const at = (...parts) => resolve(desktop, ...parts)
const defaultFixture = at('smoke', 'fixtures', 'project')
const dockerFixture = join(root, 'examples/extensions/docker/fixture')
const smoke = (script, env = {}, fixture) => ({
  fixture,
  run: ['scripts/smoke.mjs'],
  env: { PATCHBAY_SMOKE_SCRIPT: at('smoke', script), PATCHBAY_SMOKE_ROOT: defaultFixture, ...env },
})
const SCRIPTS = {
  design: smoke('design.js'),
  auth: smoke(
    'auth.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-auth/project') },
    'auth-fixture.sh',
  ),
  providers: smoke(
    'providers.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-providers/project') },
    'providers-fixture.sh',
  ),
  validation: smoke('validation.js'),
  settings: smoke('settings.js'),
  profiles: smoke('profiles.js', { PATCHBAY_SMOKE_ROUTER_KEY: 'smoke-fixture-only' }),
  auto: {
    ...smoke(
      'auto.js',
      { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-auto/project') },
      'auto-fixture.sh',
    ),
    run: ['scripts/hooks-home.mjs'],
  },
  simple: {
    ...smoke(
      'simple.js',
      { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-simple/project') },
      'simple-fixture.sh',
    ),
    run: ['scripts/hooks-home.mjs'],
  },
  planning: {
    ...smoke(
      'planning.js',
      { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-simple/project') },
      'simple-fixture.sh',
    ),
    run: ['scripts/hooks-home.mjs'],
  },
  'chat-team': {
    ...smoke(
      'chat-team.js',
      { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-team/project') },
      'chat-team-fixture.sh',
    ),
    run: ['scripts/chat-team.mjs'],
  },
  'chat-controls': smoke('chat-controls.js', {
    PATCHBAY_SMOKE_ROOT_2: defaultFixture,
  }),
  popout: smoke('popout.js'),
  bridge: smoke('bridge.js', { PATCHBAY_SMOKE_AGENT_ENDPOINT_FAILURE: '1' }),
  // Requires an installed Codex CLI and native sandbox support; run explicitly.
  'codex-network': {
    ...smoke(
      'codex-network.js',
      {
        PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-codex-network/project'),
        PATCHBAY_PROBE_DISABLED_FEATURE: 'network_proxy',
      },
      'codex-network-fixture.sh',
    ),
    manual: true,
  },
  autosave: smoke(
    'autosave.js',
    {
      PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-autosave/one'),
      PATCHBAY_SMOKE_ROOT_2: tmp('patchbay-smoke-autosave/two'),
    },
    'autosave-fixture.sh',
  ),
  views: {
    ...smoke(
      'views.js',
      { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-views/project') },
      'views-fixture.sh',
    ),
    run: ['scripts/hooks-home.mjs'],
  },
  history: smoke('history.js'),
  stories: smoke('stories.js'),
  merge: smoke(
    'merge.js',
    {
      PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-merge/project'),
    },
    'merge-fixture.sh',
  ),
  'merge-branches-chat': smoke(
    'merge-branches.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-merge/chat-primary') },
    'merge-branches-fixture.sh',
  ),
  'merge-branches-review': smoke(
    'merge-branches.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-merge/review-primary') },
    'merge-branches-fixture.sh',
  ),
  git: smoke('git.js'),
  actions: smoke(
    'actions.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-actions/project') },
    'actions-fixture.sh',
  ),
  stack: smoke('stack.js'),
  extensions: smoke('extensions.js', {
    PATCHBAY_EXTENSIONS_DIR: join(root, 'examples/extensions'),
    PATCHBAY_SMOKE_ROOT: dockerFixture,
  }),
  tasks: smoke(
    'tasks.js',
    { PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-tasks/shop') },
    'tasks-fixture.sh',
  ),
  workspace: smoke('workspace.js', {
    PATCHBAY_SMOKE_ROOT_2: defaultFixture,
  }),
  reviewers: smoke('reviewers.js', {
    PATCHBAY_SMOKE_ROOT_2: defaultFixture,
  }),
  sessions: smoke('sessions.js', {
    PATCHBAY_SMOKE_ROOT_2: defaultFixture,
  }),
  status: { run: ['scripts/status.mjs'] },
  // These two time out under parallel load (the minimap toggle, the context observation), so
  // they run alone after the rest.
  'conversation-context': { run: ['scripts/conversation-context.mjs'], serial: true },
  lifecycle: { run: ['scripts/lifecycle.mjs'] },
  navigation: { run: ['scripts/navigation-smoke.mjs'], serial: true },
  maintenance: smoke(
    'maintenance.js',
    {
      PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-maintenance/project'),
      PATCHBAY_SMOKE_ROOT_2: tmp('patchbay-smoke-maintenance/second'),
    },
    'maintenance-fixture.sh',
  ),
  dependencies: smoke(
    'dependencies.js',
    {
      PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-dependencies/project'),
      PATCHBAY_SMOKE_ROOT_2: tmp('patchbay-smoke-dependencies/second'),
    },
    'dependencies-fixture.sh',
  ),
  integrations: smoke(
    'integrations.js',
    {
      PATCHBAY_EXTENSIONS_DIR: join(root, 'extensions'),
      PATCHBAY_SMOKE_ROOT: tmp('patchbay-smoke-integrations/shop/web folder'),
    },
    'integrations-fixture.sh',
  ),
  // Not a check: rewrites docs/screenshots, so it only runs when named (`npm run screenshots`).
  readme: {
    ...smoke(
      'readme.js',
      // A short path, since Review shows the worktree's path; the fixture builds it there.
      { PATCHBAY_SMOKE_ROOT: '/tmp/patchbay-readme/northstar' },
      'readme-fixture.sh',
    ),
    run: ['scripts/readme-shots.mjs'],
    manual: true,
    serial: true,
  },
}
// Started first, so the longest scripts don't queue behind short ones and stretch the run.
const LONGEST = ['simple', 'stack', 'merge', 'tasks', 'chat-team', 'workspace', 'stories']

const args = process.argv.slice(2)
const bail = args.includes('--bail')
let jobs = 3
const names = []
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--jobs' || arg.startsWith('--jobs=')) {
    jobs = Number(arg === '--jobs' ? args[++i] : arg.slice('--jobs='.length))
    if (!Number.isInteger(jobs) || jobs < 1) {
      console.error('--jobs takes a whole number of at least 1')
      process.exit(2)
    }
  } else if (!arg.startsWith('--')) names.push(arg)
}
const unknown = names.filter((n) => !(n in SCRIPTS))
if (unknown.length) {
  console.error(`Unknown smoke script: ${unknown.join(', ')} (have ${Object.keys(SCRIPTS)})`)
  process.exit(2)
}
const selected = names.length ? names : Object.keys(SCRIPTS).filter((n) => !SCRIPTS[n].manual)

// Catch script syntax errors before launching a webview that would only report a timeout.
for (const name of selected) {
  const path = SCRIPTS[name].env?.PATCHBAY_SMOKE_SCRIPT
  if (path) new Script(readFileSync(path, 'utf8'), { filename: path })
}

// One build, the same `tauri dev` makes, so switching between them doesn't recompile.
execFileSync(process.execPath, [at('scripts/sessiond.mjs')], { cwd: desktop, stdio: 'inherit' })
execFileSync('cargo', ['build', '-p', 'patchbay-desktop', '-p', 'patchbay-cli'], {
  cwd: root,
  stdio: 'inherit',
})

// The debug binary loads `devUrl`, so one Vite server serves every run. Something else answering
// there (a running `tauri dev`) would serve the wrong frontend, so refuse to start.
const port = 1420
const answers = () =>
  fetch(`http://localhost:${port}/`).then(
    (r) => r.ok,
    () => false,
  )
if (await answers()) {
  console.error(`Port ${port} is in use; stop \`tauri dev\` before running smoke scripts.`)
  process.exit(1)
}
const vite = spawn(
  process.execPath,
  [
    join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
    '--port',
    String(port),
    '--strictPort',
  ],
  { cwd: desktop, stdio: ['ignore', 'ignore', 'inherit'] },
)
process.on('exit', () => vite.exitCode === null && vite.kill())
let viteExited = false
vite.on('exit', () => (viteExited = true))
const deadline = Date.now() + 30000
while (!(await answers()) || viteExited) {
  if (viteExited) {
    console.error(`Vite could not start on port ${port}`)
    process.exit(1)
  }
  if (Date.now() > deadline) {
    console.error(`Vite did not answer on port ${port}`)
    process.exit(1)
  }
  await new Promise((done) => setTimeout(done, 200))
}

// Each script runs in its own process group, so an interrupt reaches its app too; the launchers
// then stop their session service before exiting.
const active = new Set()
let stopping = false
const stopGroup = (child) => {
  if (child.exitCode !== null) return
  if (process.platform === 'win32') child.kill()
  else process.kill(-child.pid, 'SIGTERM')
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true
    if (!active.size) process.exit(130)
    for (const child of active) stopGroup(child)
  })
const streamed = jobs === 1
const run = (command, argv, env, log) =>
  new Promise((done) => {
    const child = spawn(command, argv, {
      cwd: desktop,
      env,
      stdio: log === undefined ? 'inherit' : ['ignore', log, log],
      detached: process.platform !== 'win32',
    })
    active.add(child)
    child.on('error', () => (active.delete(child), done(1)))
    child.on('exit', (code) => (active.delete(child), done(code ?? 1)))
  })

const resolveTmp = (value, runTmp) =>
  value?.startsWith(RUN_TMP) ? runTmp + value.slice(RUN_TMP.length) : value
let halted = false
async function runOne(name) {
  const entry = SCRIPTS[name]
  const runTmp = mkdtempSync(join(tmpdir(), 'pb-run-'))
  const env = { ...process.env, ...entry.env, PATCHBAY_SMOKE_PREBUILT: '1', TMPDIR: runTmp }
  for (const key of Object.keys(entry.env ?? {})) env[key] = resolveTmp(env[key], runTmp)
  // Every in-checkout project is a read-only template. Both workspace roots get their own
  // writable Git repositories; explicit temporary fixtures already provide their own isolation.
  for (const key of ['PATCHBAY_SMOKE_ROOT', 'PATCHBAY_SMOKE_ROOT_2']) {
    if (env[key] === defaultFixture) {
      env[key] = copySmokeProject(defaultFixture, {
        name: key === 'PATCHBAY_SMOKE_ROOT_2' ? 'Smoke second project' : undefined,
      })
    } else if (env[key] === dockerFixture) {
      // Exercise the detector even if someone has a personal map in the example folder.
      env[key] = copySmokeProject(dockerFixture, { skipMap: true })
    }
  }
  const started = Date.now()
  const logPath = join(runTmp, 'smoke.log')
  const log = streamed ? undefined : openSync(logPath, 'w')
  console.log(streamed ? `\n── smoke ${name} ──` : `start ${name}`)
  let code = entry.fixture ? await run('sh', [at('smoke', entry.fixture)], env, log) : 0
  if (code === 0 && halted) code = 1
  else if (code === 0)
    code = await run(
      process.execPath,
      entry.run.map((p) => at(p)),
      env,
      log,
    )
  const seconds = (Date.now() - started) / 1000
  // Stopped because another script failed under --bail, not a failure of its own.
  const status = halted && code !== 0 ? 'STOP' : code === 0 ? 'PASS' : 'FAIL'
  if (log !== undefined) {
    closeSync(log)
    const lines = readFileSync(logPath, 'utf8').split('\n')
    console.log(`\n── smoke ${name}: ${status} in ${seconds.toFixed(1)}s ──`)
    if (status === 'FAIL') {
      if (lines.length > 200) console.log(`… (full log: ${logPath})`)
      console.log(lines.slice(-200).join('\n'))
    } else console.log(lines.filter((l) => l.startsWith('PATCHBAY_SMOKE:')).join('\n'))
  }
  if (status === 'FAIL' && bail && !halted) {
    halted = true
    for (const child of active) stopGroup(child)
  }
  return { name, status, seconds }
}

const order = [
  ...LONGEST.filter((n) => selected.includes(n)),
  ...selected.filter((n) => !LONGEST.includes(n)),
]
const queue = order.filter((n) => !SCRIPTS[n].serial)
const serial = order.filter((n) => SCRIPTS[n].serial)
const results = []
const runStarted = Date.now()
const worker = async () => {
  while (queue.length && !halted && !stopping) results.push(await runOne(queue.shift()))
}
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker))
for (const name of serial) {
  if (halted || stopping) break
  results.push(await runOne(name))
}
if (stopping) process.exit(130)

console.log('\n── smoke summary ──')
for (const { name, status, seconds } of results)
  console.log(`${status}  ${name.padEnd(21)} ${seconds.toFixed(1)}s`)
const failed = results.filter((r) => r.status !== 'PASS').length
const wall = (Date.now() - runStarted) / 1000
console.log(
  `${results.length - failed}/${selected.length} passed in ${wall.toFixed(1)}s` +
    (jobs > 1 ? ` (${jobs} jobs)` : ''),
)
process.exit(failed || results.length < selected.length ? 1 : 0)
