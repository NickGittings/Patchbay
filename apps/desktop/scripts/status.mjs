// Give status setup its own provider configuration; never touch real user hooks.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const fixture = mkdtempSync(join(tmpdir(), 'patchbay-status-smoke-'))
const claude = join(fixture, '.claude')
const codex = join(fixture, '.codex')
mkdirSync(claude)
mkdirSync(codex)
writeFileSync(join(fixture, 'package.json'), '{"name":"status-fixture"}\n')
writeFileSync(
  join(claude, 'settings.json'),
  JSON.stringify({
    model: 'unchanged',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] },
  }),
)
writeFileSync(
  join(codex, 'config.toml'),
  "# keep user configuration\nmodel = 'unchanged'\n[hooks]\nStop = [{ hooks = [{ type = 'command', command = 'true' }] }]\n",
)
const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'smoke.mjs')], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: claude,
    CODEX_HOME: codex,
    PATCHBAY_SMOKE_ROOT: fixture,
    PATCHBAY_SMOKE_SCRIPT: resolve(import.meta.dirname, '../smoke/status.js'),
  },
})
if (result.status === 0) {
  const settings = JSON.parse(readFileSync(join(claude, 'settings.json'), 'utf8'))
  const config = readFileSync(join(codex, 'config.toml'), 'utf8')
  if (
    settings.model !== 'unchanged' ||
    settings.hooks.Stop[0].hooks[0].command !== 'true' ||
    !config.includes('# keep user configuration') ||
    !config.includes("model = 'unchanged'") ||
    !config.includes('command = "true"')
  )
    throw new Error('Hook setup modified unrelated user configuration')
}
process.exit(result.status ?? 1)
