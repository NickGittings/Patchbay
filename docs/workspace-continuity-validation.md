# Workspace continuity validation

Implementation branch: `workspace-continuity`, based on `main` at `c8805f9`.

Validated locally on macOS:

- Workspace Rust tests, including independent helper startup, concurrent/idempotent launch,
  viewer authority transfer, buffered replay, explicit stop/shutdown, service restart,
  exact Claude/Codex adapter fixtures, retained incarnations, and missing-history errors.
- Rust formatting and Clippy with warnings denied.
- Frontend TypeScript, Oxlint, Prettier and production build.
- Native pop-out, view, Git watcher, extension and two-project workspace smoke flows.
- `npm run smoke:lifecycle`: independent app quit/relaunch with the same live counter,
  restored tabs/drafts/viewport/planner scope/pop-out, delayed extension launch across tab
  switching, per-project startup activation and view message routing, deduplicated restored
  terminal tabs, terminal ownership returned after closing a Sessions preview, saved-map
  conflicts retained across another quit, explicit draft recovery, and preservation of
  malformed workspace documents. The view smoke also checks attention navigation to a
  secondary planner with opaque session IDs.
- macOS application bundle with the packaged session helper; an external isolated harness
  verified authenticated helper startup and the same process/service instance across app
  termination and relaunch.

The service and workspace tests use private temporary state and provider executables/history
fixtures. They do not use real Claude/Codex accounts or choose any user conversation.

Remaining release validation requires native Linux and Windows hosts, their packaged builds,
multiple-display geometry checks, and manual provider resume with explicitly supplied real
conversation IDs. The portable implementation is present; those platform/account checks
have not been performed on this macOS host.

For native lifecycle verification, run `npm run smoke:lifecycle` from `apps/desktop` with a
free port (`PATCHBAY_SMOKE_PORT` defaults to 1432). The harness creates two repositories and
an isolated extension/service registry, retains its artifacts, and stops only its own work.
