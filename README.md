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
- **Repos**: a project can span several git repos. Open a parent folder that holds them, or use **Add repo…** to add a repo that lives beside the project; it is stored as a relative path such as `../billing`, so keep the same folder layout on other machines. Any nested repo becomes a component even without a recognised manifest, and git status is tracked per repo.
- **Component**: a node with a name, kind, folder, notes and terminals. Its health shows which terminals are running, the last exit code (for example tests passing or failing), and uncommitted git changes in its folder.
- **Component window**: click ⧉ on a node, use **Open in window** in the Inspector, or double-click its hierarchy item. Each native window shows all of the component’s terminals alongside a file tree. Sessions and output are shared with the main dock; opening a window restores up to 512 KB of earlier output. Expand folders, double-click a file to reveal it in Finder (files are never opened directly, so a double-click can't run an executable from the repo), or use **Reveal in Finder** for the component folder. Closing the main window also closes component windows and stops their terminals.
- **Terminal**: a real PTY that opens in the component's folder. Kinds are `shell` (interactive, starts when first viewed), `task` (dev server, tests…) and `agent`.
- **Link**: "depends on". Agent terminals get `PATCHBAY_CONTEXT_FILE`, a briefing with the component's notes and its related components. Claude and Codex additionally receive the briefing as native instructions and the related folders via `--add-dir`, on Unix and Windows. Other agents show a notice that the briefing was not injected automatically.
- **Device**: a terminal preset (`*.device.json`). Add your own in `~/.patchbay/devices/`.

## Extensions

Extensions are local folders containing a `package.json`. Open **Extensions** in the toolbar,
choose **Install from folder…**, and select the extension folder. Installed folders live in
`~/.patchbay/extensions/<publisher>.<name>/`; enable/disable settings live in
`~/.patchbay/extensions.json`. **Reload** reloads manifests and restarts code hosts. Invalid
manifests stay visible with errors while other extensions continue loading. Set
`PATCHBAY_EXTENSIONS_DIR` to use another registry (including `examples/extensions`).

Manifests require `name`, `publisher`, a semantic `version`, and `engines.patchbay` (for example,
`"^0.1.0"`). `contributes` can declare devices, detectors, commands, menu placements, agent
context files, and Inspector/dock views. Each contribution id must be unique within its type
across installed extensions; use `<publisher>.<name>.<id>` for commands and views. Devices
load in built-in → extension → user order. Detectors claim folders after built-in manifest
recognition; rescanning preserves all existing edits. Context files are component-relative,
limited to 32 KiB, and checked against the same allowed roots as the file tree.

**Cmd/Ctrl+Shift+P** opens the command palette. Commands with a `run` block create a temporary
terminal at the selected component, using the existing session, policy, and PTY launch path.
These terminals appear in the dock without changing the saved project. Place commands in
`contributes.menus["component/actions"]` or `contributes.menus.toolbar`. Optional `when` clauses
support `&&`, `||`, `!`, parentheses, `==`, `!=`, `component.kind`, `component.id`,
`component.hasTerminal('id')`, `component.hasFile('file')`, and `view`. Unknown or malformed
expressions hide the contribution.

For code, set `main` to an ES module exporting `activate(patchbay)` and optionally
`deactivate()`. Activation events are `onStartup`, `onProjectOpen`, `onCommand:<id>`,
`onView:<id>`, and `workspaceContains:<file>`; first command/view use also activates its owner.
Project changes, disabling an extension, and Reload dispose old hosts. Code runs only in the
main window, in opaque-origin `sandbox="allow-scripts"` frames. The broker binds each request
to its sending frame, checks permissions, bounds messages and concurrent calls, and stops
hosts that stop answering (three timeouts in a row) or send excessive traffic; a single slow
call just fails. Commands have a 60-second deadline. Extension frames receive no Tauri API. CSP blocks
network/IPC connections; asset requests are canonicalized inside their extension directory.

The API declarations are in [`packages/extension-api/index.d.ts`](packages/extension-api/index.d.ts).
Use `project:read` for project/selection snapshots, Git status, and badge/context providers;
`terminals` for terminal launches; and `files:read` for bounded project file reads. Storage is
per extension under `~/.patchbay/extension-data/` (alongside an overridden registry). No raw
filesystem or network API is exposed. `terminals.run` returns captured output and exit status,
or `running: true` after eight seconds for a longer task; its session remains in the dock
(without taking focus), and running the same command again in that component reuses it. An
extension keeps at most eight such sessions. Extension context in a briefing is capped at 128 KiB.
Context and badge providers have a two-second response deadline. Views use
`views.registerWebviewView(id, { resolve(view), onMessage(message) })`; `view.render(html)`
mounts sandboxed HTML, and `patchbayView.postMessage` / `patchbayView.onMessage` communicate
with the extension's handler. HTML may use inline styles and scripts, with no network access.

[`examples/extensions/docker`](examples/extensions/docker) demonstrates every declarative
contribution plus container counts from a terminal task, agent context, and an Inspector view.
Its fixture uses Compose; Docker is optional for smoke verification (missing Docker displays
zero containers). Run `PATCHBAY_EXTENSIONS_DIR=examples/extensions cargo run -p patchbay-cli -- extensions`
or `... -- detect examples/extensions/docker/fixture` to inspect it. `npm run smoke:extensions`
checks the example inside the desktop app, including the iframe IPC sandbox. Project-local
extensions, marketplace/URL installs, and extension views in pop-out windows are future work.
