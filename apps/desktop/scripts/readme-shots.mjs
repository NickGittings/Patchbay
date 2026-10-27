// Takes the README screenshots (macOS only): runs smoke/readme.js against the Northstar repo
// smoke/readme-fixture.sh builds, and whenever the script reports `SHOT <name>` captures the main
// window, then answers on the app's stdin (`SHOT <name>: ok`, else the error), which the script
// waits for before its next step. Only once every view was captured are the shots copied into
// docs/screenshots, so a failed run leaves the committed ones alone. Run through
// `npm run screenshots`.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { deferSignals, launchApp, prebuilt, root, stopService } from './smoke-lib.mjs'

const EXPECTED = ['navigation', 'plan', 'build', 'review']
// The window size smoke/readme.js sets, in points.
const WIDTH = 1440
const HEIGHT = 900
if (process.platform !== 'darwin') {
  console.error('README screenshots are captured with macOS screencapture.')
  process.exit(1)
}
// Answers go to the app's stdin, which `tauri dev` doesn't pass on.
if (!prebuilt || !process.env.PATCHBAY_SMOKE_ROOT) {
  console.error('Run README screenshots through `npm run screenshots`.')
  process.exit(1)
}
// Without Screen Recording permission screencapture still succeeds, with only the desktop in the
// image.
const permitted = execFileSync(
  'osascript',
  [
    '-l',
    'JavaScript',
    '-e',
    "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []]); " +
      'String($.CGPreflightScreenCaptureAccess())',
  ],
  { encoding: 'utf8' },
).trim()
if (permitted !== 'true') {
  console.error(
    'Grant this terminal Screen Recording permission (System Settings → Privacy & Security), ' +
      'then run it again.',
  )
  process.exit(1)
}
const state = mkdtempSync(join(tmpdir(), 'patchbay-smoke-state-'))
const shots = join(state, 'shots')
mkdirSync(shots)
// Nothing from the user's own setup in the pictures: no extensions, and the Claude preset played
// by the fixture's stand-in planner (presets load from the state folder).
const extensions = join(state, 'extensions')
mkdirSync(extensions)
mkdirSync(join(state, 'devices'))
const builtin = JSON.parse(readFileSync(join(root, 'devices/claude.device.json'), 'utf8'))
writeFileSync(
  join(state, 'devices/claude.device.json'),
  JSON.stringify({ ...builtin, command: `"${dirname(process.env.PATCHBAY_SMOKE_ROOT)}/claude"` }),
)
const env = {
  ...process.env,
  PATCHBAY_STATE_DIR: state,
  PATCHBAY_EXTENSIONS_DIR: extensions,
  PATCHBAY_SMOKE_FOREGROUND: '1',
}
const interrupted = deferSignals()
const app = launchApp(env, undefined, ['pipe', 'inherit', 'pipe'])

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
  const file = join(shots, `${name}.png`)
  execFileSync('screencapture', ['-o', '-x', '-l', id, file])
  // The PNG's IHDR: the whole window, at any backing scale.
  const png = readFileSync(file)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width < WIDTH || width * HEIGHT !== height * WIDTH)
    throw new Error(`captured ${width}x${height}, not the ${WIDTH}x${HEIGHT} window`)
  console.log(`captured ${name} (${width}x${height})`)
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
    app.stdin.write(`SHOT ${shot[1]}: ${answer}\n`)
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
else if (code === 0 && !interrupted())
  for (const name of EXPECTED) {
    copyFileSync(join(shots, `${name}.png`), join(root, 'docs/screenshots', `${name}.png`))
    console.log(`updated docs/screenshots/${name}.png`)
  }
process.exit(interrupted() ? 130 : code || failure || missing.length ? 1 : 0)
