// Takes the README screenshots (macOS only): runs smoke/readme.js against the Northstar repo
// smoke/readme-fixture.sh builds, and whenever the script reports `SHOT <name>` captures the main
// window into docs/screenshots/<name>.png, then answers in the file PATCHBAY_SMOKE_ACK_FILE names
// (`SHOT <name>: ok`, else the error), which the script waits for before its next step. Passes only
// once every view was captured. Run through `npm run screenshots`.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { deferSignals, launchApp, root, stopService } from './smoke-lib.mjs'

const EXPECTED = ['navigation', 'plan', 'build', 'review']
if (process.platform !== 'darwin') {
  console.error('README screenshots are captured with macOS screencapture.')
  process.exit(1)
}
const state = mkdtempSync(join(tmpdir(), 'patchbay-smoke-state-'))
const ack = join(state, 'smoke-ack')
writeFileSync(ack, '')
const env = {
  ...process.env,
  PATCHBAY_STATE_DIR: state,
  PATCHBAY_SMOKE_FOREGROUND: '1',
  PATCHBAY_SMOKE_ACK_FILE: ack,
}
const interrupted = deferSignals()
const app = launchApp(env, undefined, ['ignore', 'inherit', 'pipe'])

/** `pid` and its descendants: under `tauri dev` the app is a grandchild of the launched CLI. */
const family = (pid) => {
  let children = []
  try {
    children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
  } catch {
    // pgrep exits 1 when there are none.
  }
  return [pid, ...children.flatMap(family)]
}

// The app's largest window: the main one (pop-outs aren't opened by readme.js).
const windowId = (pids) =>
  execFileSync(
    'osascript',
    [
      '-l',
      'JavaScript',
      '-e',
      `ObjC.import('CoreGraphics')
       const pids = ${JSON.stringify(pids)}
       const list = ObjC.deepUnwrap(ObjC.castRefToObject(
         $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
       const ours = list.filter((w) => pids.includes(w.kCGWindowOwnerPID) && w.kCGWindowLayer === 0)
       ours.sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height -
         a.kCGWindowBounds.Width * a.kCGWindowBounds.Height)
       ours.length ? String(ours[0].kCGWindowNumber) : ''`,
    ],
    { encoding: 'utf8' },
  ).trim()

const capture = (name) => {
  if (!EXPECTED.includes(name)) throw new Error(`unexpected shot ${name}`)
  const id = windowId(family(app.pid))
  if (!id) throw new Error(`no window to capture (pid ${app.pid})`)
  const file = join(root, 'docs/screenshots', `${name}.png`)
  execFileSync('screencapture', ['-o', '-x', '-l', id, file])
  console.log(`captured ${file}`)
}

const captured = new Set()
let failure = ''
createInterface({ input: app.stderr }).on('line', (line) => {
  process.stderr.write(line + '\n')
  const shot = line.match(/^PATCHBAY_SMOKE: SHOT (\S+)/)
  if (!shot) return
  let answer = 'ok'
  try {
    capture(shot[1])
    captured.add(shot[1])
  } catch (e) {
    answer = String(e?.message ?? e).replace(/\s+/g, ' ')
    failure ||= `capturing ${shot[1]}: ${answer}`
    console.error(failure)
  }
  try {
    appendFileSync(ack, `SHOT ${shot[1]}: ${answer}\n`)
  } catch (e) {
    failure ||= `answering ${shot[1]}: ${e?.message ?? e}`
  }
  // The script fails on a failed answer and the app exits; stop it should it not.
  if (failure) setTimeout(() => app.kill(), 10000).unref()
})
const code = await new Promise((done) => {
  app.on('error', () => done(1))
  app.on('exit', (exit) => done(exit ?? 1))
})
stopService(env)
const missing = EXPECTED.filter((name) => !captured.has(name))
if (failure) console.error(`README screenshots failed: ${failure}`)
else if (missing.length) console.error(`README screenshots missing: ${missing.join(', ')}`)
process.exit(interrupted() ? 130 : code || failure || missing.length ? 1 : 0)
