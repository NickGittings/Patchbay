// Shared by the smoke launchers (`smoke.mjs`, `lifecycle.mjs`, `readme-shots.mjs`): start the
// desktop app, stop a run's session service, and outlive an interrupt long enough to do that.
import { spawn, execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
export const desktop = resolve(import.meta.dirname, '..')
export const root = resolve(desktop, '../..')
/** Set by `smoke-all.mjs`, which has built the app and serves its Vite on port 1420. */
export const prebuilt = Boolean(process.env.PATCHBAY_SMOKE_PREBUILT)

export const binary = (name) =>
  join(
    resolve(root, process.env.CARGO_TARGET_DIR || 'target'),
    'debug',
    name + (process.platform === 'win32' ? '.exe' : ''),
  )

/**
 * The prebuilt app, or `tauri dev` (with an optional config override) when run on its own. `stdio`
 * is passed to `spawn`, for a launcher that reads the app's reports from its stderr.
 */
export function launchApp(env, config, stdio = 'inherit') {
  if (prebuilt)
    return spawn(binary('patchbay-desktop'), [], { cwd: join(desktop, 'src-tauri'), env, stdio })
  const args = [require.resolve('@tauri-apps/cli/tauri.js'), 'dev']
  if (config) args.push('--config', config)
  return spawn(process.execPath, args, { cwd: desktop, env, stdio })
}

/** Stop the session service of the run whose state dir `env` names, if one started. */
export function stopService(env) {
  const shutdown = ['sessions', 'shutdown', '--stop-running']
  try {
    if (prebuilt)
      execFileSync(binary('patchbay-cli'), shutdown, { cwd: root, env, stdio: 'inherit' })
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
}

/**
 * Survive SIGINT/SIGTERM so the caller's cleanup can stop its service: `smoke-all.mjs` signals the
 * whole process group, so the app exits by itself. Returns whether a signal arrived.
 */
export function deferSignals() {
  let interrupted = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (interrupted = true))
  return () => interrupted
}
