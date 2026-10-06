// Runs smoke scripts against one build and one Vite server instead of a `tauri dev` per script.
//   node scripts/smoke-all.mjs                  every script, in order, then a summary
//   node scripts/smoke-all.mjs views git        just those (the `npm run smoke:*` entries)
//   node scripts/smoke-all.mjs --bail           stop at the first failure
// Scripts run one at a time: fixtures use fixed temp paths and the checks are timing-sensitive.
import { spawn, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { desktop, root } from './smoke-lib.mjs'
const require = createRequire(import.meta.url)
// Where the `smoke/*-fixture.sh` scripts put their repos (`${TMPDIR:-/tmp}`).
const temp = tmpdir()
const at = (...parts) => resolve(desktop, ...parts)
const smoke = (script, env = {}, fixture) => ({
  fixture,
  run: ['scripts/smoke.mjs'],
  env: { PATCHBAY_SMOKE_SCRIPT: at('smoke', script), PATCHBAY_SMOKE_ROOT: root, ...env },
})
const SCRIPTS = {
  popout: smoke('popout.js'),
  views: smoke('views.js'),
  git: smoke('git.js'),
  actions: smoke(
    'actions.js',
    { PATCHBAY_SMOKE_ROOT: join(temp, 'patchbay-smoke-actions/project') },
    'actions-fixture.sh',
  ),
  extensions: smoke('extensions.js', {
    PATCHBAY_EXTENSIONS_DIR: join(root, 'examples/extensions'),
    PATCHBAY_SMOKE_ROOT: join(root, 'examples/extensions/docker/fixture'),
  }),
  tasks: smoke(
    'tasks.js',
    { PATCHBAY_SMOKE_ROOT: join(temp, 'patchbay-smoke-tasks/shop') },
    'tasks-fixture.sh',
  ),
  workspace: smoke('workspace.js', {
    PATCHBAY_SMOKE_ROOT_2: join(root, 'examples/extensions/docker/fixture'),
  }),
  status: { run: ['scripts/status.mjs'] },
  lifecycle: { run: ['scripts/lifecycle.mjs'] },
  navigation: { run: ['scripts/navigation-smoke.mjs'] },
  maintenance: smoke(
    'maintenance.js',
    {
      PATCHBAY_SMOKE_ROOT: join(temp, 'patchbay-smoke-maintenance/project'),
      PATCHBAY_SMOKE_ROOT_2: join(temp, 'patchbay-smoke-maintenance/second'),
    },
    'maintenance-fixture.sh',
  ),
  integrations: smoke(
    'integrations.js',
    {
      PATCHBAY_EXTENSIONS_DIR: join(root, 'extensions'),
      PATCHBAY_SMOKE_ROOT: join(temp, 'patchbay-smoke-integrations/shop/web folder'),
    },
    'integrations-fixture.sh',
  ),
}

const args = process.argv.slice(2)
const bail = args.includes('--bail')
const names = args.filter((a) => !a.startsWith('--'))
const unknown = names.filter((n) => !(n in SCRIPTS))
if (unknown.length) {
  console.error(`Unknown smoke script: ${unknown.join(', ')} (have ${Object.keys(SCRIPTS)})`)
  process.exit(2)
}
const selected = names.length ? names : Object.keys(SCRIPTS)

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
let current
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true
    if (!current || current.exitCode !== null) process.exit(130)
    if (process.platform === 'win32') current.kill()
    else process.kill(-current.pid, 'SIGTERM')
  })
const run = (command, argv, env) =>
  new Promise((done) => {
    current = spawn(command, argv, {
      cwd: desktop,
      env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    })
    current.on('error', () => done(1))
    current.on('exit', (code) => done(code ?? 1))
  })
const results = []
for (const name of selected) {
  const entry = SCRIPTS[name]
  const env = { ...process.env, ...entry.env, PATCHBAY_SMOKE_PREBUILT: '1' }
  const started = Date.now()
  console.log(`\n── smoke ${name} ──`)
  let code = entry.fixture ? await run('sh', [at('smoke', entry.fixture)], env) : 0
  if (code === 0)
    code = await run(
      process.execPath,
      entry.run.map((p) => at(p)),
      env,
    )
  results.push({ name, code, seconds: (Date.now() - started) / 1000 })
  if (stopping) process.exit(130)
  if (code !== 0 && bail) break
}

console.log('\n── smoke summary ──')
for (const { name, code, seconds } of results)
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(13)} ${seconds.toFixed(1)}s`)
const total = results.reduce((sum, r) => sum + r.seconds, 0)
const failed = results.filter((r) => r.code !== 0).length
console.log(`${results.length - failed}/${results.length} passed in ${total.toFixed(1)}s`)
process.exit(failed || results.length < selected.length ? 1 : 0)
