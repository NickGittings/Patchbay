// Shared by the smoke launchers (`smoke.mjs`, `lifecycle.mjs`, `readme-shots.mjs`): start the
// desktop app, stop a run's session service and delete its WebKit store, and outlive an interrupt
// long enough to do that.
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
export const desktop = resolve(import.meta.dirname, '..')
export const root = resolve(desktop, '../..')
/** Set by `smoke-all.mjs`, which has built the app and serves its Vite (`PATCHBAY_DEV_PORT`). */
export const prebuilt = Boolean(process.env.PATCHBAY_SMOKE_PREBUILT)

export const binary = (name) =>
  join(
    resolve(root, process.env.CARGO_TARGET_DIR || 'target'),
    'debug',
    name + (process.platform === 'win32' ? '.exe' : ''),
  )

/**
 * The prebuilt app, or `tauri dev` on a free Vite port (`scripts/tauri.mjs`) when run on its own.
 * `stdio` is passed to `spawn`, for a launcher that reads the app's reports from its stderr.
 */
export function launchApp(env, stdio = 'inherit') {
  if (prebuilt)
    return spawn(binary('patchbay-desktop'), [], { cwd: join(desktop, 'src-tauri'), env, stdio })
  return spawn(process.execPath, [join(desktop, 'scripts/tauri.mjs'), 'dev'], {
    cwd: desktop,
    env,
    stdio,
  })
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
  removeWebKitStore(env)
}

/**
 * Delete the WebKit store the run's app recorded in `webkit-store` (`smoke::window`), which
 * otherwise stays under ~/Library/WebKit/<app>/WebsiteDataStore after every run.
 */
function removeWebKitStore(env) {
  if (process.platform !== 'darwin' || !env.PATCHBAY_STATE_DIR) return
  let id
  try {
    id = readFileSync(join(env.PATCHBAY_STATE_DIR, 'webkit-store'), 'utf8').trim()
  } catch {
    return // The app never built a window.
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return
  const webkit = join(homedir(), 'Library', 'WebKit')
  let apps = []
  try {
    apps = readdirSync(webkit)
  } catch {
    return
  }
  // Named after the binary or bundle; the identifier is unique, so look under each. WebKit's
  // network process can still be writing into it just after the app exits, so retry, and leave
  // a store that won't go rather than fail the run.
  for (const app of apps) {
    try {
      rmSync(join(webkit, app, 'WebsiteDataStore', id), {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      })
    } catch {
      // The store stays behind; the run's result doesn't depend on it.
    }
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
