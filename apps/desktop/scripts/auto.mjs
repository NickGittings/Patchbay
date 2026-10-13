// Keep fixture status-hook setup away from the user's provider configuration.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const config = join(mkdtempSync(join(tmpdir(), 'patchbay-auto-hooks-')), '.codex')
mkdirSync(config)
writeFileSync(join(config, 'config.toml'), '')
const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'smoke.mjs')], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, CODEX_HOME: config },
})
process.exit(result.status ?? 1)
