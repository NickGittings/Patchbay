// Runs one smoke script with its own PATCHBAY_STATE_DIR, so a run neither restores nor leaves
// behind workspaces and sessions (the user's or another run's), then stops that run's session
// service, leaving its state in the temp folder for inspection. Under `smoke-all.mjs`
// (PATCHBAY_SMOKE_PREBUILT) it launches the binary that runner built against its Vite server;
// otherwise it runs `tauri dev` with the smoke window config.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const state = mkdtempSync(join(tmpdir(), 'patchbay-smoke-state-'))
const env = { ...process.env, PATCHBAY_STATE_DIR: state }
const prebuilt = Boolean(process.env.PATCHBAY_SMOKE_PREBUILT)
const exe = process.platform === 'win32' ? '.exe' : ''
const binary = (name) =>
  join(resolve(root, process.env.CARGO_TARGET_DIR || 'target'), 'debug', name + exe)
const [command, args] = prebuilt
  ? [binary('patchbay-desktop'), []]
  : [
      process.execPath,
      [
        require.resolve('@tauri-apps/cli/tauri.js'),
        'dev',
        '--config',
        join(desktop, 'src-tauri/tauri.smoke.conf.json'),
      ],
    ]
const code = await new Promise((done) => {
  const child = spawn(command, args, {
    cwd: prebuilt ? join(desktop, 'src-tauri') : desktop,
    env,
    stdio: 'inherit',
  })
  child.on('error', () => done(1))
  child.on('exit', (exit) => done(exit ?? 1))
})
const shutdown = ['sessions', 'shutdown', '--stop-running']
try {
  if (prebuilt) execFileSync(binary('patchbay'), shutdown, { cwd: root, env, stdio: 'inherit' })
  else
    execFileSync('cargo', ['run', '-q', '-p', 'patchbay-cli', '--', ...shutdown], {
      cwd: root,
      env,
      stdio: 'inherit',
    })
} catch (e) {
  // No service was started, or it already exited; a missing binary is a runner bug.
  if (e.code === 'ENOENT') throw e
}
process.exit(code)
