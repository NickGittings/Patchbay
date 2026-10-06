// Tauri expects external binaries named with their target triple before bundling.
import { execFileSync } from 'node:child_process'
import { mkdirSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const target =
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1]
const release = process.argv.includes('--release')
const args = [
  'build',
  '-p',
  'patchbay-sessiond',
  '--target',
  target,
  ...(release ? ['--release'] : []),
]
execFileSync('cargo', args, { cwd: root, stdio: 'inherit' })
const extension = target.includes('windows') ? '.exe' : ''
const source = resolve(
  root,
  process.env.CARGO_TARGET_DIR || 'target',
  target,
  release ? 'release' : 'debug',
  `patchbay-sessiond${extension}`,
)
const directory = resolve(import.meta.dirname, '../src-tauri/binaries')
mkdirSync(directory, { recursive: true })
copyFileSync(source, resolve(directory, `patchbay-sessiond-${target}${extension}`))
// cargo tauri dev uses the host target/debug directory.
if (!release)
  copyFileSync(
    source,
    resolve(
      root,
      process.env.CARGO_TARGET_DIR || 'target',
      'debug',
      `patchbay-sessiond${extension}`,
    ),
  )
