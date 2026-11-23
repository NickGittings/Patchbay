// `npm run tauri`: the Tauri CLI, except that `dev` gets its own Vite port (`dev-port.mjs`)
// instead of failing when another worktree's app already serves 1420. The port reaches Vite
// through `beforeDevCommand` and the app through `PATCHBAY_DEV_PORT`, so `tauri.conf.json`, and
// with it the compiled app, stays the same.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { DEFAULT_DEV_PORT, DEV_PORT_ENV, devPort } from './dev-port.mjs'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const env = { ...process.env }
// Global flags (`-v`) may precede the subcommand.
if (args.find((arg) => !arg.startsWith('-')) === 'dev') {
  if (!env[DEV_PORT_ENV]) {
    const port = await devPort()
    if (port !== DEFAULT_DEV_PORT)
      console.error(`Port ${DEFAULT_DEV_PORT} is in use; serving the frontend on ${port}.`)
    env[DEV_PORT_ENV] = String(port)
  }
  // The CLI only knows `devUrl`'s port; the app waits for the chosen one itself.
  env.TAURI_CLI_NO_DEV_SERVER_WAIT = 'true'
}
const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...args], {
  env,
  stdio: 'inherit',
})
// The CLI shares this process group, so a terminal interrupt reaches it directly; a SIGTERM sent
// to this pid alone (`child.kill()`, a process manager) is passed on.
process.on('SIGINT', () => {})
process.on('SIGTERM', () => child.kill('SIGTERM'))
child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
