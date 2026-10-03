# Repository Guidelines

## Project Structure & Module Organization

Patchbay maps repository components onto a desktop canvas with live terminals.

- `crates/patchbay-core/src/`: headless engine for project models, repository detection, PTY sessions, agent context, Git status, devices, and policy hooks.
- `crates/patchbay-cli/src/`: CLI commands using the core engine.
- `apps/desktop/src/`: React/TypeScript UI; components in `components/`, shared helpers and IPC wrappers in `lib/`.
- `apps/desktop/src-tauri/`: Tauri backend, capabilities, configuration, and icon assets.
- `devices/`: built-in `*.device.json` terminal presets.

Keep shared behavior in the core crate and desktop integration in the Tauri backend.

## Build, Test, and Development Commands

Prerequisites: Rust via rustup and Node.js 20+. Run Cargo commands from the repository root; run npm commands from `apps/desktop`.

- `npm install`: install desktop dependencies.
- `npm run tauri dev`: start the desktop app with development tooling.
- `npm run dev`: start the Vite frontend server.
- `npm run build`: type-check and build frontend assets.
- `npm run tauri build`: build the desktop application.
- `cargo build --workspace`: build all Rust workspace members.
- `cargo run -p patchbay-cli -- detect .`: inspect component detection.
- `cargo fmt --all -- --check`: verify Rust formatting.
- `cargo clippy --workspace --all-targets -- -D warnings`: enforce Rust lint checks.
- `cargo test --workspace`: run Rust tests.
- `npm run check`: run TypeScript, Oxlint, and Prettier checks.

## Coding Style & Naming Conventions

Use spaces, LF endings, and a final newline: two-space indentation generally, four spaces for Rust. Format Rust with rustfmt and frontend files with `npm run format`. Prettier uses single quotes, no semicolons, trailing commas, and a 100-column print width. Use PascalCase React component filenames, camelCase TypeScript functions, and snake_case Rust modules/functions. Workspace lints forbid unsafe Rust.

## Testing Guidelines

Rust tests use built-in `#[test]` functions in inline `mod tests` blocks. Name tests after behavior, such as `merge_adds_only_new_folders`. Add regression tests near changed core logic; isolate filesystem fixtures in temporary directories. PTY tests currently run on Unix only. No frontend test runner or coverage threshold is configured; verify UI changes manually in the desktop app.

## Commit & Pull Request Guidelines

History currently contains one descriptive subject with an explanatory body; no formal prefix convention is established. Use concise subjects describing the change. PRs should explain behavior, link related issues when applicable, report validation commands, and include screenshots for UI changes.
