// Runs `tauri dev` for one smoke script with its own PATCHBAY_STATE_DIR, so a run neither
// restores nor leaves behind workspaces and sessions (the user's or another run's), then stops
// that run's session service, leaving its state in the temp folder for inspection.
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
const code = await new Promise((done) => {
  const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'dev'], {
    cwd: desktop,
    env,
    stdio: 'inherit',
  })
  child.on('error', () => done(1))
  child.on('exit', (exit) => done(exit ?? 1))
})
try {
  execFileSync(
    'cargo',
    ['run', '-q', '-p', 'patchbay-cli', '--', 'sessions', 'shutdown', '--stop-running'],
    { cwd: root, env, stdio: 'inherit' },
  )
} catch {
  // No service was started, or it already exited.
}
process.exit(code)
