// Keep fixture status-hook setup away from the user's provider configuration: both providers
// start without hooks in a private home.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const home = mkdtempSync(join(tmpdir(), 'patchbay-smoke-hooks-'))
// The launcher signals the whole process group, so the smoke run stops too: wait for it, then
// clean up, rather than leaving the home behind.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {})
let status = 1
try {
  const codex = join(home, '.codex'),
    claude = join(home, '.claude')
  mkdirSync(codex)
  mkdirSync(claude)
  writeFileSync(join(codex, 'config.toml'), '')
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'smoke.mjs')], {
    cwd: resolve(import.meta.dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude },
  })
  status = result.status ?? 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(status)
