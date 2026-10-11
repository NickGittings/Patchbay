// Runs one smoke script with its own PATCHBAY_STATE_DIR, so a run neither restores nor leaves
// behind workspaces and sessions (the user's or another run's), then stops that run's session
// service, leaving its state in the temp folder for inspection. Under `smoke-all.mjs` it launches
// the binary that runner built; run on its own, it uses `tauri dev`.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deferSignals, launchApp, stopService } from './smoke-lib.mjs'
const state = mkdtempSync(join(tmpdir(), 'patchbay-smoke-state-'))
// A directory where the endpoint file belongs forces a real bridge startup I/O failure.
if (process.env.PATCHBAY_SMOKE_AGENT_ENDPOINT_FAILURE) mkdirSync(join(state, 'agent-endpoint'))
const env = { ...process.env, PATCHBAY_STATE_DIR: state }
const interrupted = deferSignals()
const code = await new Promise((done) => {
  const child = launchApp(env)
  child.on('error', () => done(1))
  child.on('exit', (exit) => done(exit ?? 1))
})
stopService(env)
process.exit(interrupted() ? 130 : code)
