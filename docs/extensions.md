# Extension development

[Back to the README](../README.md#extensions). For the supported Docker Compose and browser
preview integrations, see [supported local integrations](../extensions/README.md).

## Installation

Extensions are local folders containing a `package.json`. Open **Tools → Extensions…** in the
toolbar, choose **Install from folder…**, and select the extension folder. Choose
**Open extensions folder** in the same panel to find the active installation directory. Enable
or disable extensions in the panel; those settings live in `~/.patchbay/extensions.json`.
**Reload** reloads manifests and restarts code hosts. Invalid manifests stay visible with errors
while other extensions continue loading.

Installation copies the source folder; editing the source does not update the installed copy.
To update an extension, choose **Open extensions folder**, delete its `<publisher>.<name>`
folder there, then install the updated source folder again. Installing over an existing copy
fails with an "already installed" error. Use **Reload** after editing installed files directly.

## Development override

Set `PATCHBAY_EXTENSIONS_DIR` to an **absolute path** when starting Patchbay to load extension
source folders directly. Choose a dedicated folder containing only extensions: every immediate
subfolder is treated as an extension, so a general projects folder such as `~/code` would list
unrelated repositories as broken extensions. The override replaces the default
`~/.patchbay/extensions` registry entirely; only the override folder is loaded, and
**Install from folder…** copies new installs into it too. When loading source folders directly,
edit them and use **Reload**; installing them again would create copies beside the sources.

For the supported integrations, run from the repository root:

```sh
export PATCHBAY_EXTENSIONS_DIR="$PWD/extensions"
cargo run -p patchbay-cli -- extensions
(cd apps/desktop && npm run tauri dev)
```

Set the variable before changing directories so its value stays absolute when launching from
`apps/desktop`. Extension storage is written to `extension-data/` beside the registry; the
example above writes to `<repo>/extension-data/`. That generated directory and
`<repo>/examples/extension-data/` (used by the example below) are ignored by Git. Prefer a
dedicated folder outside a repository for other local extensions and their storage. Unset
`PATCHBAY_EXTENSIONS_DIR` before restarting Patchbay to return to the default registry.

## Manifest contributions

Manifests require `name`, `publisher`, a semantic `version`, and `engines.patchbay` (for example,
`"^0.1.0"`). `contributes` can declare devices, detectors, commands, menu placements, agent
context files, and Inspector/dock views. Each contribution id must be unique within its type
across installed extensions; use `<publisher>.<name>.<id>` for commands and views. Devices
load in built-in → extension → user order. Detectors claim folders after built-in manifest
recognition; rescanning preserves all existing edits. Context files are component-relative,
limited to 32 KiB, and checked against the same allowed roots as the file tree.

## Commands and menus

**Cmd/Ctrl+Shift+P** opens the command palette. Commands with a `run` block create a temporary
terminal at the selected component, using the existing session, policy, and PTY launch path.
These terminals appear in the dock without changing the saved project. Place commands in
`contributes.menus["component/actions"]` or `contributes.menus.toolbar` (listed under **Tools**).
Optional `when` clauses support `&&`, `||`, `!`, parentheses, `==`, `!=`, `component.kind`, `component.id`,
`component.hasTerminal('id')`, `component.hasFile('file')`, and `view`. Unknown or malformed
expressions hide the contribution.

## Runtime and sandbox

For code, set `main` to an ES module exporting `activate(patchbay)` and optionally
`deactivate()`. Activation events are `onStartup`, `onProjectOpen`, `onCommand:<id>`,
`onView:<id>`, and `workspaceContains:<file>`; first command/view use also activates its owner.
Each project/task retains its own host when tabs or tasks change. Disabling an extension or
choosing **Reload** disposes its hosts. Code runs only in the main window, in opaque-origin
`sandbox="allow-scripts"` frames. The broker binds each request to its sending frame, checks
permissions, bounds messages and concurrent calls, and stops
hosts that stop answering (three timeouts in a row) or send excessive traffic; a single slow
call just fails. Commands have a 60-second deadline. Extension frames receive no Tauri API. CSP blocks
network/IPC connections; asset requests are canonicalized inside their extension directory.

## API and permissions

The API declarations are in [`packages/extension-api/index.d.ts`](../packages/extension-api/index.d.ts).
Use `project:read` for project/selection snapshots, Git status, and badge/context providers;
`terminals` for terminal launches; `files:read` for bounded project file reads;
`sessions:read` for component task-terminal URL summaries; and the separate `urls:open`
permission for native-validated HTTP/HTTPS browser opening. `workspace.get` reports the
host’s stable project/task identity. Commands and file reads use that task’s worktree. Storage is
per extension under `~/.patchbay/extension-data/` (alongside an overridden registry). No raw
filesystem or network API is exposed. `terminals.run` returns captured output and exit status,
or `running: true` after eight seconds for a longer task; its session remains in the dock
(without taking focus), and running the same command again in that component reuses it. An
extension keeps at most eight such sessions. Extension context in a briefing is capped at 128 KiB.
Context and badge providers have a two-second response deadline. Views use
`views.registerWebviewView(id, { resolve(view), onMessage(message) })`; `view.render(html)`
mounts sandboxed HTML, and `patchbayView.postMessage` / `patchbayView.onMessage` communicate
with the extension's handler. HTML may use inline styles and scripts, with no network access.

## Example and validation

[`examples/extensions/docker`](../examples/extensions/docker) demonstrates every declarative
contribution plus container counts from a terminal task, agent context, and an Inspector view.
Its fixture uses Compose; Docker is optional for smoke verification (missing or failing
Docker displays an error and preserves the last successful result). From the repository root,
inspect the extension and its detected components with:

```sh
PATCHBAY_EXTENSIONS_DIR="$PWD/examples/extensions" cargo run -p patchbay-cli -- extensions
PATCHBAY_EXTENSIONS_DIR="$PWD/examples/extensions" cargo run -p patchbay-cli -- detect examples/extensions/docker/fixture
```

Run `npm run smoke:extensions` from `apps/desktop` to check the example inside the desktop app,
including the iframe IPC sandbox. Project-local extensions, marketplace/URL installs, and
extension views in pop-out windows are future work.
