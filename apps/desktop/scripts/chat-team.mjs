// Exercise the same saved conversation across two independent desktop processes.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deferSignals, desktop, launchApp, stopService } from './smoke-lib.mjs'
const state = mkdtempSync(join(tmpdir(), 'patchbay-chat-restart-'))
const codex = join(state, 'codex')
const claude = join(state, 'claude')
mkdirSync(codex)
mkdirSync(claude)
writeFileSync(join(codex, 'config.toml'), '')
const env = {
  ...process.env,
  PATCHBAY_STATE_DIR: state,
  CODEX_HOME: codex,
  CLAUDE_CONFIG_DIR: claude,
}
const interrupted = deferSignals()
let code = 0
try {
  for (const script of ['chat-team.js', 'chat-restart.js']) {
    if (interrupted()) {
      code = 130
      break
    }
    code = await new Promise((done) => {
      const child = launchApp({ ...env, PATCHBAY_SMOKE_SCRIPT: join(desktop, 'smoke', script) })
      child.on('error', () => done(1))
      child.on('exit', (exit) => done(exit ?? 1))
    })
    if (code) break
  }
} finally {
  stopService(env)
}
process.exit(interrupted() ? 130 : code)
