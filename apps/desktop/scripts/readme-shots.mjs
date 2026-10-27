// Takes the README screenshots (macOS only): runs smoke/readme.js against the Northstar repo
// smoke/readme-fixture.sh builds, and whenever the script reports `SHOT <name>` captures the main
// window into docs/screenshots/<name>.png. The script holds each view for a few seconds after
// reporting, so the capture never races its next step. Run through `npm run screenshots`.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { binary, deferSignals, root, stopService } from './smoke-lib.mjs'

if (process.platform !== 'darwin') {
  console.error('README screenshots are captured with macOS screencapture.')
  process.exit(1)
}
const state = mkdtempSync(join(tmpdir(), 'patchbay-smoke-state-'))
const env = { ...process.env, PATCHBAY_STATE_DIR: state, PATCHBAY_SMOKE_FOREGROUND: '1' }
const interrupted = deferSignals()
const app = spawn(binary('patchbay-desktop'), [], {
  cwd: join(root, 'apps/desktop/src-tauri'),
  env,
  stdio: ['ignore', 'inherit', 'pipe'],
})

// The app's largest window: the main one (pop-outs aren't opened by readme.js).
const windowId = (pid) =>
  execFileSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('CoreGraphics')
       const list = ObjC.deepUnwrap(ObjC.castRefToObject(
         $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
       const ours = list.filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0)
       ours.sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height -
         a.kCGWindowBounds.Width * a.kCGWindowBounds.Height)
       ours.length ? String(ours[0].kCGWindowNumber) : ''`,
    ],
    { encoding: 'utf8' },
  ).trim()

let shots = 0
createInterface({ input: app.stderr }).on('line', (line) => {
  process.stderr.write(line + '\n')
  const shot = line.match(/^PATCHBAY_SMOKE: SHOT (\S+)/)
  if (!shot) return
  const id = windowId(app.pid)
  if (!id) return console.error(`no window to capture for ${shot[1]} (pid ${app.pid})`)
  const file = join(root, 'docs/screenshots', `${shot[1]}.png`)
  execFileSync('screencapture', ['-o', '-x', '-l', id, file])
  console.log(`captured ${file}`)
  shots += 1
})
const code = await new Promise((done) => {
  app.on('error', () => done(1))
  app.on('exit', (exit) => done(exit ?? 1))
})
stopService(env)
process.exit(interrupted() ? 130 : code || (shots ? 0 : 1))
