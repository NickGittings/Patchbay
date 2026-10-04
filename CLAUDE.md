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
cargo run -p patchbay-cli -- plan crates-patchbay-core --dir . # planner briefing for a highlighted set

# Checks (run all before considering work done)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd apps/desktop && npm run check)                     # tsc -b + oxlint src + prettier --check
(cd apps/desktop && npm run smoke)                     # opens the app, drives a pop-out window, exits 0/1
(cd apps/desktop && npm run smoke:views)               # view switching and local planner lifecycle
(cd apps/desktop && npm run smoke:git)                 # watcher signals and idle Git refresh behavior

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

The backend is stateless with respect to the project map; it only holds PTY sessions and their output backlogs, plus core-owned file access and a Git watcher (`access.rs`/`watch.rs`, `AppState { pty, access, watcher }`): the open project's root (chosen in the backend's `open_project` picker) and the external folders the user vouched for (`AccessSnapshot.granted`: folders picked in a backend-run dialog — `add_folder`, `pick_component_folder` — or external folders of a loaded `patchbay.json` that the user allowed in the dialog `open_project` shows; until then those components are "locked", returned in `Opened.locked`). File commands (`list_dir`, `reveal_path`) take paths relative to the root and may read only the root plus external component folders on the map that lie within `granted`; the frontend's `sync_roots` (debounced and ordered after component path changes, `App.tsx` and `lib/access.ts`) can narrow that set but never widen it. Grants refresh the current map even when its paths are unchanged; `patchbay://file-access` tells open file trees to retry. Filesystem checks run on snapshots without holding the access lock; the adapter dispatches synchronization, briefing and launch work to blocking workers. All access checks compare canonical paths (so symlinks can't widen them), and no granted folder may contain the project root (`model::check_component_dir`). Every command that takes a `Project` replaces its root with the backend's (`AccessSnapshot::trust`); commands that launch or brief (`terminal_start`, `plan_start`, `component_context`, `plan_context`) also drop locked components (`AccessSnapshot::restrict`), and `git_status` skips folders that aren't readable. `rescan_project`/`add_folder` return only what they added (`Added`), which the frontend appends to its current map. The zustand store (`src/store.ts`) holds the map as React Flow `nodes`/`edges`, and `toProject()` rebuilds a full `Project` that is passed to every command that needs it (`terminal_start`, `component_context`, `save_project`, `rescan_project`). `dirty` tracks unsaved edits.

### Keeping Rust and TS in sync

Types are mirrored by hand — there is no codegen:
- `crates/patchbay-core/src/model.rs` / `events.rs` / `devices.rs` (serde, `camelCase`) ↔ `apps/desktop/src/types.ts`
- Tauri command list in `src-tauri/src/lib.rs` (`generate_handler!`) ↔ wrappers in `apps/desktop/src/lib/ipc.ts` (Tauri converts camelCase args to snake_case params)
- The terminal event channel name `patchbay://terminal` appears in both `lib.rs` and `ipc.ts`.
- The Git invalidation channel `patchbay://git-dirty` appears in both `lib.rs` and `ipc.ts`.
- `pty::Snapshot` ↔ `TerminalSnapshot`, `files::DirEntry` ↔ `DirEntry` in `types.ts`.
- `model::PLAN_SCOPE` ↔ `types.ts` `PLAN_SCOPE` (reserved `"@plan"` scope).
- Session ids are `"{componentId}/{terminalId}"` (`model::session_id` ↔ `types.ts` `sessionId`).

Changing a model field or command means updating both sides.

### Core modules

- `model.rs` — `Project`/`Component`/`Link`/`TerminalSpec`. Persisted as `patchbay.json` at the repo root; `root` is absolute in memory but never serialized (portable file). A `Link` means `source` depends on `target`; `Project::neighbours` returns both directions as `Relation::DependsOn`/`UsedBy`. Bump `SCHEMA_VERSION` for format changes.
- `detect.rs` — walks the repo for `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `go.mod`; infers kind, task terminals (dev/test/etc.), links from inter-package deps, and a layered layout. Nested git repos without a manifest still become components. `merge_new` only adds components for folders not already in the project (compared after resolving symlinks, `model::resolve_dir`) and appends them — it must never touch user edits. `detect_folder` (Add repo…) detects a picked folder with paths relative to the project root (`../sibling` for a repo outside it); it rejects the root and any folder containing it. `rescan` = root plus the given external folders (the external component folders themselves, never their enclosing repo, so a monorepo isn't swept in). Ids come from `slug`, which never returns an empty string.
- `context.rs` — `component_context` builds the markdown briefing; `session_spec` turns a terminal into a `SessionSpec`. For `agent` terminals it writes the briefing to `$TMPDIR/patchbay/<slug>.md` and sets `PATCHBAY_CONTEXT_FILE`; if the command is `claude` (Unix only) it appends `--add-dir` for each neighbour and `--append-system-prompt "$(cat …)"`. All terminals get `PATCHBAY_COMPONENT`. The `Policy` check runs here, before spawn (currently `AllowAll`).
- `pty.rs` — `PtyManager` spawns commands via the user's login shell (`$SHELL -ilc`, or `-il` for an empty command = interactive shell) so PATH matches their terminal when launched from the dock; Windows uses `cmd.exe /C` / `powershell.exe`. `spawn` reserves the id in `starting` and creates the process without holding the `sessions` lock, so other sessions' I/O isn't blocked. Per session: one reader thread emitting `Output` events, one waiter thread emitting `Exited` (exit code normalized: success → 0, failure → ≥1). Remembers last size per session id across restarts. Each session id also keeps a `Backlog` (last 512 KB of output, total byte count `end`, `generation` bumped on every spawn, running/exit code) that outlives the process; `snapshot()` returns it (data base64-encoded on the wire) so a newly opened window can replay output it missed. `Output` events carry `seq` (byte offset) and all events carry `generation` (globally increasing) so consumers can de-duplicate against a snapshot. Session ids aren't project-scoped, so opening a project calls `reset()` (`terminal_reset`, also run on app exit), which hangs up everything, drops all backlogs, waits up to `RESET_GRACE` for the processes (tracked as `orphans`) and then kills their process groups, and returns a generation floor; the frontend's `resetSessions(floor)` clears its caches and ignores late events at or below it.
- `events.rs` — `TerminalEvent` (`started`/`output`/`exited`) and the `EventSink` trait; Tauri implements the sink by emitting to the webview.
- `devices.rs` — terminal presets. Built-ins in `/devices/*.device.json` are compiled in via `include_str!` (add new ones to the `BUILTIN` list too); user presets in `~/.patchbay/devices/` override built-ins by id.
- `files.rs` — `list_dir` for the pop-out file tree: dirs first, hides only `.git` (not detection's `SKIP_DIRS`), and hides symlinks resolving outside the roots; `resolve` rejects paths escaping every root. Roots are the project root plus external folders (`../billing`), and must already be canonical: they are never resolved again, so a root later swapped for a symlink can't redirect listings. Nested roots are deduplicated. Paths in and out are relative to the project root.
- `git.rs` — `status` groups components by containing repo (`group_by_repo`, nearest `.git`), runs `git --no-optional-locks status --porcelain=v2` once per repo (in parallel threads, fsmonitor off; callers pass only canonical, allowed folders), and attributes each file to the most specific component (`owner_of`); nested repos aren't counted by their parent. Also reports the repo name for components outside the project root's repo. The main window refreshes on project/component-path and access changes, window focus, terminal exits, and debounced filesystem changes (`lib/git.ts`); requests are coalesced and stale results discarded. Pop-outs receive the resulting badges through the existing `patchbay://git` broadcast.
- `watch.rs` — core-owned background watcher with a 1s debouncer, watching only roots inside a Git repo. FSEvents/Windows get one recursive watch per outermost root (FSEvents restarts its stream on every added path); inotify/kqueue register directories individually so ignored trees consume no watches. Ignore rules are cached per repo (`Rules`: one `ls-files -oi --directory` plus `ls-files -ci` per load, then batched `check-ignore --stdin` for unknown event paths and their parents); tracked paths stay observable under ignored directories. Rule files, `info/exclude`, config and the global excludes file (mtime checked every 5s) reload the rules; an index change only rescans when its ignored-but-tracked files changed. Unreadable or vanished directories are skipped; only failed watches mark coverage incomplete, which refreshes status every 5s and retries with backoff (30s–5min). Missing roots are polled every 1s for their return, without status polling. New root sets refresh once their coverage is registered. `GitWatcher::update` replaces a worker that died. Shutdown signals cancellation without waiting for traversal. Linked worktree metadata (`.git` files) is not resolved yet, so commits there may wait for focus or terminal exit.

### Frontend terminals

`lib/terminals.ts` keeps one long-lived xterm instance per session id in a module-level registry and re-parents its DOM element on `attach`, so scrollback survives tab switches and restarts. `lib/sessions.ts` applies backend `TerminalEvent`s to both the store (running/exit code → node health) and the xterm, skipping bytes already covered by a snapshot (`seq`/`generation`). `hydrateSession` buffers live events, replays `terminal_snapshot`, then drains the buffer. `components/TerminalPane.tsx` is the shared xterm host used by the dock and pop-out tiles.

### Views

The main window switches between Navigation (hierarchy, canvas, dock and inspector), Plan (highlighted canvas above a project-level planner dock), and Implementation (the selected component's tiled terminals). `view`, `highlighted`, and `planStartedWith` live only in the session UI store; they never change `dirty` or `patchbay.json`. Plan terminals come from agent devices and use the reserved `@plan/<terminalId>` session scope. `plan_start` / `plan_context` in the Tauri adapter ↔ `planStart` / `planContext` in `lib/ipc.ts`; `context::plan_session_spec` launches at the repo root with the scoped briefing (`claude` also gets `--add-dir` for in-scope or nearby components outside the root), while `policy::Scope` supplies either a component or the planner's real component set to policy checks. `TerminalGrid` is shared by Implementation and component pop-outs. All views use the same session and xterm registries, preserving scrollback and window ownership.

### Component windows

Each component can open in a native window labelled `component-<hex-encoded id>` that loads `index.html?component=<id>`; `main.tsx` routes that to `ComponentWindow` (file tree + every terminal tiled). Every webview is a separate JS context with its own store and xterm registry. The main window stays the owner of the project: a pop-out emits `patchbay://popout-ready`, and `lib/windows.ts` answers with `patchbay://project` and `patchbay://git`, re-broadcasting (debounced) on edits; pop-outs apply it with `syncProject`, which keeps session state. Closing the main window closes all pop-outs (`lib.rs` `on_window_event`), and opening another project closes them too. Terminal events go to the main window on `patchbay://terminal` and to a pop-out only on `patchbay://terminal/<its label>` (`TauriSink`; `component_window_label` must match `componentLabel` in `windows.ts`). A session can be shown in several windows at once; `windows.ts` tracks the last-focused window across webviews and `ownsSession` picks one window per session to resize its PTY and answer terminal queries (xterm `onData` is gated on focus or ownership, and replayed output never replies). New window labels must match `component-*` in `capabilities/default.json`.
