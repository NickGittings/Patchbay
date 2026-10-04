// Independent process harness: app quit/relaunch must leave the service and counter alive.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const fixture = mkdtempSync(join(tmpdir(), 'patchbay-desktop-lifecycle-'))
const localState = join(fixture, 'state')
const counter =
  process.platform === 'win32'
    ? 'powershell -NoProfile -Command "Write-Output process:$PID; $i=0; while ($true) { Write-Output number:$i; $i++; Start-Sleep -Milliseconds 100 }"'
    : 'echo process:$$; i=0; while :; do echo number:$i; i=$((i+1)); sleep 0.1; done'
for (const name of ['one', 'two']) {
  const dir = join(fixture, name)
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'patchbay.json'),
    JSON.stringify({
      schemaVersion: 2,
      name,
      root: '',
      components: [
        {
          id: 'shared',
          name: 'Shared',
          kind: 'app',
          path: '.',
          notes: '',
          position: { x: 0, y: 0 },
          terminals: [{ id: 'counter', name: 'Counter', kind: 'task', command: counter }],
        },
      ],
      links: [],
    }),
  )
}
const registry = join(fixture, 'extensions')
const extension = join(registry, 'fixture.continuity')
mkdirSync(extension, { recursive: true })
writeFileSync(
  join(extension, 'package.json'),
  JSON.stringify({
    name: 'continuity',
    publisher: 'fixture',
    version: '0.1.0',
    engines: { patchbay: '^0.1.0' },
    main: 'extension.js',
    activationEvents: ['onProjectOpen'],
    permissions: ['project:read', 'terminals'],
    contributes: { commands: [{ id: 'fixture.continuity.run', title: 'Continuity probe' }] },
  }),
)
writeFileSync(
  join(extension, 'extension.js'),
  `export async function activate(pb) {
  await pb.commands.registerCommand('fixture.continuity.run', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const project = await pb.project.get()
    return pb.terminals.run(project.components[0].id, 'echo extension-origin; sleep 1')
  }).ready
}`,
)
const port = Number(process.env.PATCHBAY_SMOKE_PORT || 1432)
const config = join(fixture, 'tauri.json')
writeFileSync(
  config,
  JSON.stringify({
    build: {
      devUrl: `http://localhost:${port}`,
      beforeDevCommand: `npm run prepare:sessiond && npm run dev -- --port ${port}`,
    },
  }),
)
const env = {
  ...process.env,
  PATCHBAY_STATE_DIR: localState,
  PATCHBAY_EXTENSIONS_DIR: registry,
  PATCHBAY_SMOKE_SCRIPT: join(desktop, 'smoke/lifecycle.js'),
  PATCHBAY_SMOKE_ROOT: join(fixture, 'one'),
  PATCHBAY_SMOKE_ROOT_2: join(fixture, 'two'),
}
const run = () =>
  new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve('@tauri-apps/cli/tauri.js'), 'dev', '--config', config],
      { cwd: desktop, env, stdio: 'inherit' },
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Desktop exited ${code}`)),
    )
  })
const sessions = () => JSON.parse(readFileSync(join(localState, 'sessiond/sessions.json'), 'utf8'))
try {
  await run()
  const before = Object.values(sessions()).find((r) => r.metadata.terminalId === 'counter')
  if (!before?.snapshot.running) throw new Error('Quit stopped the counter')
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500))
  await run()
  const after = Object.values(sessions()).find((r) => r.metadata.terminalId === 'counter')
  if (
    !after?.snapshot.running ||
    after.snapshot.generation !== before.snapshot.generation ||
    after.snapshot.end <= before.snapshot.end
  )
    throw new Error('Process incarnation changed or output did not continue')
  const saved = JSON.parse(readFileSync(join(fixture, 'one/patchbay.json'), 'utf8'))
  if (saved.components[0].notes) throw new Error('Autosave overwrote patchbay.json')
  saved.components[0].notes = 'external edit'
  writeFileSync(join(fixture, 'one/patchbay.json'), JSON.stringify(saved))
  for (const phase of [3, 4]) {
    const script = join(fixture, `recovery-${phase}.js`)
    writeFileSync(
      script,
      `window.__patchbayRecoveryPhase = ${phase}\n` +
        readFileSync(join(desktop, 'smoke/lifecycle.js'), 'utf8'),
    )
    env.PATCHBAY_SMOKE_SCRIPT = script
    await run()
  }
  const recovered = JSON.parse(readFileSync(join(localState, 'workspaces/default.json'), 'utf8'))
  if (recovered.projects[0].draft?.components[0].notes !== 'recovery draft')
    throw new Error('Explicitly recovered draft was not autosaved')
  if (
    JSON.parse(readFileSync(join(fixture, 'one/patchbay.json'), 'utf8')).components[0].notes !==
    'external edit'
  )
    throw new Error('Recovering overwrote the saved map')
  const invalid = '{invalid workspace'
  writeFileSync(join(localState, 'workspaces/default.json'), invalid)
  const malformedScript = join(fixture, 'malformed.js')
  writeFileSync(
    malformedScript,
    'window.__patchbayRecoveryPhase = 5\n' +
      readFileSync(join(desktop, 'smoke/lifecycle.js'), 'utf8'),
  )
  env.PATCHBAY_SMOKE_SCRIPT = malformedScript
  await run()
  if (readFileSync(join(localState, 'workspaces/default.json'), 'utf8') !== invalid)
    throw new Error('Native autosave overwrote malformed recovery state')
  process.stdout.write(
    `PASS external lifecycle: same generation ${after.snapshot.generation}, output ${before.snapshot.end} → ${after.snapshot.end}; artifacts ${fixture}\n`,
  )
} finally {
  // Stop only this harness's work, retaining artifacts for inspection.
  execFileSync(
    'cargo',
    ['run', '-p', 'patchbay-cli', '--', 'sessions', 'shutdown', '--stop-running'],
    { cwd: root, env, stdio: 'inherit' },
  )
}
