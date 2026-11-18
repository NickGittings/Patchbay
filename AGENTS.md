# Repository Guidelines

Patchbay maps repository components onto a desktop canvas with live terminals and coordinated agents.

## Project structure

Four Cargo workspace members share a React frontend:

- `crates/patchbay-core/src/`: UI-independent models, detection, PTYs, agent context and orchestration, Git, devices, and policy hooks. Keep shared behavior here.
- `crates/patchbay-cli/src/`: CLI over the core engine, including authenticated agent commands.
- `crates/patchbay-sessiond/src/`: persistent terminal service executable; session behavior lives in core.
- `apps/desktop/src-tauri/src/`: desktop integration, native windows, access grants, and Tauri commands across `lib.rs` and dedicated modules. Keep shared engine logic in core.
- `apps/desktop/src/`: React 19, React Flow, xterm.js, and zustand; components in `components/`, shared helpers and IPC wrappers in `lib/`.
- `apps/desktop/smoke/`: in-app end-to-end scripts and disposable fixtures.
- `devices/`: built-in terminal presets. `extensions/`: bundled extensions; `packages/extension-api/index.d.ts`: extension author API.

## Commands and validation

Prerequisites: Rust via rustup (edition 2024) and Node.js matching `apps/desktop/package.json` engines. Run Cargo commands from the repository root and npm commands from `apps/desktop`.

| Task                               | Command                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| Install desktop dependencies       | `npm install`                                                    |
| Run desktop / frontend only        | `npm run tauri dev` / `npm run dev`                              |
| Build frontend / desktop           | `npm run build` / `npm run tauri build`                          |
| Build Rust workspace               | `cargo build --workspace`                                        |
| Inspect component detection        | `cargo run -p patchbay-cli -- detect .`                          |
| Inspect planner briefing           | `cargo run -p patchbay-cli -- plan crates-patchbay-core --dir .` |
| Check Rust formatting              | `cargo fmt --all -- --check`                                     |
| Check Rust lints                   | `cargo clippy --workspace --all-targets -- -D warnings`          |
| Run Rust tests                     | `cargo nextest run --workspace` or `cargo test --workspace`      |
| Check frontend                     | `npm run check`                                                  |
| Run frontend unit tests            | `npm test`                                                       |
| Run all smoke tests / pop-out only | `npm run smoke:all` / `npm run smoke`                            |
| Run a smoke subset                 | `node scripts/smoke-all.mjs views git --bail`                    |
| Run smoke scripts one at a time    | `node scripts/smoke-all.mjs --jobs 1` (default: 3 in parallel)   |
| Retake README screenshots (macOS)  | `npm run screenshots`                                            |

For code changes, run the Rust formatting, lint and test checks and `npm run check`. Before merging into `main`, run the desktop smoke suite (`npm run smoke:all`) on the proposed merge result in a temporary worktree. Update `main` after the suite passes. If a desktop session is unavailable, report the blocker before updating `main`. `npm run check` includes TypeScript, Oxlint, Prettier, Vitest, and Node smoke-fixture tests. See `package.json` for area-specific `smoke:*` scripts. Install optional nextest with `cargo install cargo-nextest --locked`.

### Testing constraints

- Rust tests use inline `#[cfg(test)] mod tests`; add behavior-named regression tests near changed core logic and isolate filesystem fixtures in temporary directories. PTY tests run on Unix. `.config/nextest.toml` limits process-spawning tests. Filter tests with `cargo test -p patchbay-core detect`.
- Frontend tests use Vitest's Node environment, alongside modules as `src/**/*.test.ts`. Mock the store and Tauri APIs for logic tests; verify rendered UI through smoke tests and manual desktop checks.
- Shared encodings such as `sessionId` and `componentLabel` have paired Rust/TypeScript golden tests; update both together.
- Smoke tests need a desktop session and port 1420; stop `tauri dev` first. Use disposable fixture repositories and isolated state, never the personal root map.
- Smoke hooks (`src-tauri/src/smoke.rs`, `src/lib/smoke.ts`, `window.__patchbaySmoke`) must remain debug/dev-only. `PATCHBAY_SMOKE_SCRIPT` enables the harness.
- Smoke windows run without focus on macOS. Verify focus events, `document.hasFocus()`, terminal authority claims, focus-driven `terminal_seen`, and Git refresh on focus manually; smoke checks cannot wait on them. Screenshot runs are the documented foreground exception.
- Read [smoke launcher internals](docs/architecture/smoke.md) before changing the harness, fixtures, process handling, or screenshots.

## Style

Follow `.editorconfig`: spaces, LF, final newline, two-space indentation except four for Rust. Format Rust with rustfmt and frontend files with `npm run format`. Prettier uses single quotes, no semicolons, trailing commas, and width 100. Use PascalCase React component filenames, camelCase TypeScript functions, and snake_case Rust modules/functions.

Workspace lints forbid unsafe Rust. The desktop adapter uses `deny` so macOS-only `writing_tools.rs` can locally allow its Objective-C calls; keep its other lints aligned with the workspace. Clippy checks run with `-D warnings`, including truncation, wrap, and sign-loss cast warnings: use checked conversions or targeted allowances. Public fallible functions carry applicable `# Errors` / `# Panics` docs; pure getters use `#[must_use]`.

Use concise commit subjects describing the change. PRs explain behavior, link related issues, report validation, and include screenshots for UI changes.

## Architecture and contracts

The frontend zustand store owns the map as React Flow nodes/edges; `toProject()` rebuilds the command payload, and `dirty` tracks unsaved map edits. The backend does not own the editable map. `rescan_project` and `add_folder` return additions for the frontend to append.

Terminal processes and backlogs live in `patchbay-sessiond`, using core's session engine. Desktop `service::Bridge` uses pooled loopback connections and an ordered input/resize writer. Sessions outlive the app. Preserve the `Hello`/`Shutdown` retirement wire format and active older sessions when changing the protocol.

Per-project backend `ProjectAccess { access, watcher, task_root }` owns trusted roots, external-folder grants, Git watchers, and the active task worktree. Backend dialogs grant access; frontend `sync_roots` can only narrow it. Check canonical paths, exclude locked components from launches/briefings, and replace caller-provided project roots with `AccessSnapshot::trust`. Run filesystem and launch work on blocking workers without holding access locks.

Rust and TypeScript interfaces are mirrored by hand. Changes to model fields, commands, events, or shared encodings require both sides and their paired tests to change together. Core serde models generally use camelCase; Tauri command arguments map frontend camelCase to Rust snake_case. Session IDs are opaque: use recorded `Metadata` and frontend `sessionMetadata`, never parse hashes.

### Topic references

Read the relevant topic before editing its area. Keep implementation details in these documents:

- [Data flow](docs/architecture/data-flow.md): file access, project IPC, grants, command restrictions, and session protocol retirement.
- [Rust/TS synchronization](docs/architecture/rust-ts-sync.md): mirrored models, commands, events, shared encodings, and paired contracts.
- [Core modules](docs/architecture/core-modules.md): core behavior, sessions, reviews, and agent briefings.
- [Plan handoff](docs/architecture/plan-handoff.md): shared plans, proposals, and implement/fix kickoff behavior.
- [Dependency and stack detection](docs/architecture/dependency-and-stack-detection.md): manifest and agent-assisted discovery and proposals.
- [Graph actions](docs/architecture/graph-actions.md): action scope, execution, and validation.
- [Worktrees](docs/architecture/worktrees.md): tasks, branch lifecycle, merge cleanup, and session ownership.
- [Frontend terminals](docs/architecture/frontend-terminals.md): mounting, replay, input authority, and session reconciliation.
- [Views and Auto](docs/architecture/views-and-auto.md): view state, role presets, and Auto stage ownership/gates.
- [Scheduler](docs/architecture/scheduler.md): background runs, planner ownership, scheduling, and launch gates.
- [Provider runs](docs/architecture/provider-runs.md): multi-provider scans, coordinated builds, worker assignments, integration, and recovery.
- [Component windows](docs/architecture/component-windows.md): pop-out routing, project broadcasts, and terminal authority.
- [Extensions](docs/architecture/extensions.md): registry, permissions, hosts, and contribution APIs.
- [Chat mode](docs/architecture/chat-mode.md): timeline, navigation, Markdown, replies, composer, queued prompts, persistent lead coordination, and review councils.
- [Story board](docs/architecture/story-board.md): story hierarchy, planning, task linkage, and derived status.

## Maintaining agent guidance

`AGENTS.md` is the shared source of repository instructions; keep `CLAUDE.md` as a short pointer to it. Keep this file under 15,000 bytes (`wc -c AGENTS.md`). Update the relevant `docs/architecture/<topic>.md` when behavior changes and add a short, explicitly triggered pointer for new topics. Load topic docs only for the area being changed; keep their implementation details out of the always-loaded instructions.
