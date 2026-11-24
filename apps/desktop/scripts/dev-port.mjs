// The Vite port for one desktop run: 1420 when it is free, otherwise any free port, so several
// worktrees can run `tauri dev` and smoke scripts at once. The debug app reads the port from
// `PATCHBAY_DEV_PORT` (`src-tauri/src/dev_server.rs`), as does `vite.config.ts`.
import { createServer } from 'node:net'

export const DEV_PORT_ENV = 'PATCHBAY_DEV_PORT'
export const DEFAULT_DEV_PORT = 1420

/** The port bound on `host`, or null if it is taken. */
const bind = (host, port) =>
  new Promise((done) => {
    const server = createServer()
    server.once('error', () => done(null))
    server.listen(port, host, () => {
      const bound = server.address().port
      server.close(() => done(bound))
    })
  })

// Vite listens on `localhost`, which may resolve to either address, so both must be free.
async function free(port) {
  const bound = await bind('127.0.0.1', port)
  if (bound === null) return null
  // No IPv6 loopback at all can't clash with anything.
  const v6 = await bind('::1', bound)
  return v6 !== null || !(await bind('::1', 0)) ? bound : null
}

/** A free port, preferring `preferred`. Another process may still take it before Vite does. */
export async function devPort(preferred = DEFAULT_DEV_PORT) {
  const port = await free(preferred)
  if (port !== null) return port
  for (let i = 0; i < 20; i++) {
    const any = await free(0)
    if (any !== null) return any
  }
  throw new Error('No free port for Vite')
}
