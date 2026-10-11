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
  '-p',
  'patchbay-cli',
  '--target',
  target,
  ...(release ? ['--release'] : []),
]
execFileSync('cargo', args, { cwd: root, stdio: 'inherit' })
const extension = target.includes('windows') ? '.exe' : ''
const directory = resolve(import.meta.dirname, '../src-tauri/binaries')
mkdirSync(directory, { recursive: true })
for (const binary of ['patchbay-sessiond', 'patchbay-cli']) {
  const source = resolve(
    root,
    process.env.CARGO_TARGET_DIR || 'target',
    target,
    release ? 'release' : 'debug',
    `${binary}${extension}`,
  )
  copyFileSync(source, resolve(directory, `${binary}-${target}${extension}`))
  if (!release)
    copyFileSync(
      source,
      resolve(root, process.env.CARGO_TARGET_DIR || 'target', 'debug', `${binary}${extension}`),
    )
}
