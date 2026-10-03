# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Prerequisites: Rust (edition 2024, via rustup), Node 20+.

```sh
# Desktop app (Tauri 2 + React)
cd apps/desktop && npm install
npm run tauri dev

# CLI (no UI) — useful for exercising core logic quickly
cargo run -p patchbay-cli -- detect .                  # suggested component map for a dir
cargo run -p patchbay-cli -- context patchbay-core     # agent briefing for a component

# Checks (run all before considering work done)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd apps/desktop && npm run check)                     # tsc -b + oxlint src + prettier --check
(cd apps/desktop && npm run smoke)                     # opens the app, drives a pop-out window, exits 0/1

# Single test
cargo test -p patchbay-core context::tests::claude_gets_neighbour_dirs_and_context
cargo test -p patchbay-core detect                     # all tests matching "detect"
```

There is no frontend unit test suite; Rust unit tests live in `#[cfg(test)] mod tests` at the bottom of each core module. `npm run smoke` is the one end-to-end check: in debug builds only, `src-tauri/src/smoke.rs` evaluates `$PATCHBAY_SMOKE_SCRIPT` in every window and exits 0/1 when the script emits `PASS…`/`FAIL…` on `patchbay://smoke-report`; `src/lib/smoke.ts` exposes the store and helpers as `window.__patchbaySmoke` (dev bundles only). Never add test hooks that run in release builds.

## Lints and style

- Workspace lints (`Cargo.toml`): `unsafe_code = "forbid"`, clippy `all` plus `cast_possible_truncation`/`cast_possible_wrap`/`cast_sign_loss` as warnings, and CI-style clippy runs with `-D warnings` — so these casts must be handled (`try_from`, or a targeted `#[allow]`). Public fallible fns carry `# Errors` / `# Panics` doc sections and pure getters `#[must_use]`.
- Frontend: Prettier (no semicolons, single quotes, width 100, trailing commas), oxlint with react/typescript plugins.
- `.editorconfig`: 2-space indent, 4 for `.rs`, LF.

## Architecture

Three Cargo workspace members plus a React frontend:

- `crates/patchbay-core` — all real logic, UI-agnostic (driven by the desktop app, the CLI, or a future server).
- `crates/patchbay-cli` — thin wrapper over core.
- `apps/desktop/src-tauri` — thin Tauri adapter: each `#[tauri::command]` in `src/lib.rs` maps to one core call. Keep logic out of here.
- `apps/desktop/src` — React 19 + React Flow canvas + xterm.js + zustand.

### Data flow: the frontend owns the project

The backend is stateless with respect to the project map; it only holds PTY sessions and their output backlogs (`AppState { pty: Arc<PtyManager> }`). The zustand store (`src/store.ts`) holds the map as React Flow `nodes`/`edges`, and `toProject()` rebuilds a full `Project` that is passed to every command that needs it (`terminal_start`, `component_context`, `save_project`, `rescan_project`). `dirty` tracks unsaved edits.

### Keeping Rust and TS in sync

Types are mirrored by hand — there is no codegen:
- `crates/patchbay-core/src/model.rs` / `events.rs` / `devices.rs` (serde, `camelCase`) ↔ `apps/desktop/src/types.ts`
- Tauri command list in `src-tauri/src/lib.rs` (`generate_handler!`) ↔ wrappers in `apps/desktop/src/lib/ipc.ts` (Tauri converts camelCase args to snake_case params)
- The terminal event channel name `patchbay://terminal` appears in both `lib.rs` and `ipc.ts`.
- `pty::Snapshot` ↔ `TerminalSnapshot`, `files::DirEntry` ↔ `DirEntry` in `types.ts`.
- Session ids are `"{componentId}/{terminalId}"` (`model::session_id` ↔ `types.ts` `sessionId`).

Changing a model field or command means updating both sides.

### Core modules

- `model.rs` — `Project`/`Component`/`Link`/`TerminalSpec`. Persisted as `patchbay.json` at the repo root; `root` is absolute in memory but never serialized (portable file). A `Link` means `source` depends on `target`; `Project::neighbours` returns both directions as `Relation::DependsOn`/`UsedBy`. Bump `SCHEMA_VERSION` for format changes.
- `detect.rs` — walks the repo for `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`; infers kind, task terminals (dev/test/etc.), links from inter-package deps, and a layered layout. `merge_new` (Rescan) only adds components for folders whose `path` isn't already in the project — it must never touch user edits.
- `context.rs` — `component_context` builds the markdown briefing; `session_spec` turns a terminal into a `SessionSpec`. For `agent` terminals it writes the briefing to `$TMPDIR/patchbay/<slug>.md` and sets `PATCHBAY_CONTEXT_FILE`; if the command is `claude` (Unix only) it appends `--add-dir` for each neighbour and `--append-system-prompt "$(cat …)"`. All terminals get `PATCHBAY_COMPONENT`. The `Policy` check runs here, before spawn (currently `AllowAll`).
- `pty.rs` — `PtyManager` spawns commands via the user's login shell (`$SHELL -ilc`, or `-il` for an empty command = interactive shell) so PATH matches their terminal when launched from the dock; Windows uses `cmd.exe /C` / `powershell.exe`. Per session: one reader thread emitting `Output` events, one waiter thread emitting `Exited` (exit code normalized: success → 0, failure → ≥1). Remembers last size per session id across restarts. Each session id also keeps a `Backlog` (last 512 KB of output, total byte count `end`, `generation` bumped on every spawn, running/exit code) that outlives the process; `snapshot()` returns it (data base64-encoded on the wire) so a newly opened window can replay output it missed. `Output` events carry `seq` (byte offset) and all events carry `generation` (globally increasing) so consumers can de-duplicate against a snapshot. Session ids aren't project-scoped, so opening a project calls `reset()` (`terminal_reset`), which kills everything, drops all backlogs and returns a generation floor; the frontend's `resetSessions(floor)` clears its caches and ignores late events at or below it.
- `events.rs` — `TerminalEvent` (`started`/`output`/`exited`) and the `EventSink` trait; Tauri implements the sink by emitting to the webview.
- `devices.rs` — terminal presets. Built-ins in `/devices/*.device.json` are compiled in via `include_str!` (add new ones to the `BUILTIN` list too); user presets in `~/.patchbay/devices/` override built-ins by id.
- `files.rs` — `list_dir` for the pop-out file tree: dirs first, hides `.git` and `detect::SKIP_DIRS`, and rejects paths (including symlinks) resolving outside the root.
- `git.rs` — uncommitted-change counts per component folder; the frontend polls this every 5s (`App.tsx`).

### Frontend terminals

`lib/terminals.ts` keeps one long-lived xterm instance per session id in a module-level registry and re-parents its DOM element on `attach`, so scrollback survives tab switches and restarts. `lib/sessions.ts` applies backend `TerminalEvent`s to both the store (running/exit code → node health) and the xterm, skipping bytes already covered by a snapshot (`seq`/`generation`). `hydrateSession` buffers live events, replays `terminal_snapshot`, then drains the buffer. `components/TerminalPane.tsx` is the shared xterm host used by the dock and pop-out tiles.

### Component windows

Each component can open in a native window labelled `component-<hex-encoded id>` that loads `index.html?component=<id>`; `main.tsx` routes that to `ComponentWindow` (file tree + every terminal tiled). Every webview is a separate JS context with its own store and xterm registry. The main window stays the owner of the project: a pop-out emits `patchbay://popout-ready`, and `lib/windows.ts` answers with `patchbay://project` and `patchbay://git`, re-broadcasting (debounced) on edits; pop-outs apply it with `syncProject`, which keeps session state. Closing the main window closes all pop-outs (`lib.rs` `on_window_event`), and opening another project closes them too. A session can be shown in several windows at once; only the focused window resizes its PTY (`terminals.ts` `fit`). New window labels must match `component-*` in `capabilities/default.json`.
