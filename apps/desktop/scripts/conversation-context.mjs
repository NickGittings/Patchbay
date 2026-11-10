// Disposable provider settings and offline CLIs; never uses the user's accounts or transcripts.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const fixture = mkdtempSync(join(tmpdir(), 'patchbay-conversations-'))
const project = join(fixture, 'project')
mkdirSync(project)
writeFileSync(join(project, 'package.json'), '{"name":"conversation-fixture"}\n')
for (const name of ['claude', 'codex']) {
  mkdirSync(join(fixture, `.${name}`))
  copyFileSync(resolve(import.meta.dirname, '../smoke/conversation-agent.py'), join(fixture, name))
  chmodSync(join(fixture, name), 0o700)
}
writeFileSync(
  join(fixture, '.claude/settings.json'),
  JSON.stringify({
    statusLine: { type: 'command', command: "printf 'chained-status-line'" },
  }),
)
writeFileSync(join(fixture, '.codex/config.toml'), '')
const result = spawnSync(process.execPath, [resolve(import.meta.dirname, 'smoke.mjs')], {
  cwd: resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: join(fixture, '.claude'),
    CODEX_HOME: join(fixture, '.codex'),
    PATCHBAY_SMOKE_ROOT: project,
    PATCHBAY_SMOKE_SCRIPT: resolve(import.meta.dirname, '../smoke/conversation-context.js'),
  },
})
process.exit(result.status ?? 1)
