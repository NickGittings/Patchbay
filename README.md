# Patchbay

See your application one component at a time. Patchbay maps a repo's main parts (frontend, API, libraries, services) as nodes on a canvas. Each node has its own live terminals (shell, dev server, tests, an AI agent) plus health at a glance. Links show what depends on what, and agents get that as context.

## Layout

| Path | What |
|---|---|
| `crates/patchbay-core` | Headless engine: project model, repo detection, PTY sessions, agent context, git status, device presets, policy hook |
| `crates/patchbay-cli` | `patchbay detect [dir]` and `patchbay context <component>` without the UI |
| `apps/desktop` | Tauri 2 + React app (React Flow canvas, xterm.js terminals) |
| `devices/` | Built-in terminal presets (same format as user devices) |

## Develop

Prerequisites: Rust (rustup), Node 20+.

```sh
cd apps/desktop
npm install
npm run tauri dev        # desktop app
```

```sh
cargo run -p patchbay-cli -- detect .                       # suggested component map
cargo run -p patchbay-cli -- context patchbay-core          # what an agent on that component is told
```

## Checks

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
(cd apps/desktop && npm run check)   # tsc + oxlint + prettier
```

## Concepts

- **Project**: open a repo folder. Patchbay loads `patchbay.json` from the root, or, if there isn't one, detects components from `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt` and `go.mod`. Review the result, then Save to write `patchbay.json` (commit it to share the map). **Rescan** adds components for new folders without touching your edits.
- **Component**: a node with a name, kind, folder, notes and terminals. Its health shows which terminals are running, the last exit code (for example tests passing or failing), and uncommitted git changes in its folder.
- **Component window**: click ⧉ on a node, use **Open in window** in the Inspector, or double-click its hierarchy item. Each native window shows all of the component’s terminals alongside a file tree. Sessions and output are shared with the main dock; opening a window restores up to 512 KB of earlier output. Expand folders, double-click files to open their default app, or use **Reveal in Finder**. Closing the main window also closes component windows and stops their terminals.
- **Terminal**: a real PTY that opens in the component's folder. Kinds are `shell` (interactive, starts when first viewed), `task` (dev server, tests…) and `agent`.
- **Link**: "depends on". Agent terminals get `PATCHBAY_CONTEXT_FILE`, a briefing with the component's notes and its related components. `claude` additionally gets that briefing appended to its system prompt and the related folders via `--add-dir`.
- **Device**: a terminal preset (`*.device.json`). Add your own in `~/.patchbay/devices/`.
