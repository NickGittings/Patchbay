# Stage 4 validation — 2026-10-06

Validated on macOS arm64, on the continuity foundation merged at `472338a`.

Passed:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace`: 190 core tests, 3 CLI tests, 2 session helper lifecycle tests. The unchanged FSEvents lifecycle test timed out in the filesystem sandbox; the complete suite passed with native filesystem event access.
- `npm run check` and `npm run build` in `apps/desktop` (existing bundle-size advisory remains).
- `node extensions/tests.mjs`: Docker successful, empty, absent/failing, malformed and stale responses; stable project/task/component Compose names; no activation launches; preview URL validation and short per-scope storage keys; delayed action/result isolation; subscription disposal.
- `npm run smoke:integrations`: real session-service URL output and permission checks; no server start on preview refresh; invalid browser URLs denied natively; independent retained task hosts; sandboxed Docker command retains its task; preview view excludes the main task URL; task file reads and terminal launches from a project nested inside its Git repository; explicit Docker unavailable/failing result.
- `npm run smoke:extensions`: existing third-party detector/device/context/view and iframe/forged IPC sandbox checks, repeated task reuse and reload.
- `npm run smoke:tasks`: parallel worktree terminals, Git badges/review and removal.

Native smoke runners required loopback/Desktop access beyond the filesystem sandbox. The smoke harness isolated session state and stopped its own sessions on exit. Packaged `patchbay-sessiond` was prepared for the native host target before testing.

Release checks outstanding:

- Docker CLI is installed but the local daemon socket is unavailable. Real `Up`, `Down`, `Logs`, per-container health and simultaneous Compose environments must be exercised with a running daemon. Deterministic extension fixtures cover successful/failing responses, and native smoke covers the actual failing query.
- Packaged application/browser opening and supported extension commands on Windows/Linux; this macOS run does not establish readiness there.
- Final combined navigation, maintenance, provider status, graph actions, workspace and lifecycle smoke checks after the other stages are integrated.
