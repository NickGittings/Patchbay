### Extensions

- `crates/patchbay-core/src/extensions.rs` validates local manifests (`engines.patchbay`), isolates
  errors, persists disabled ids (disabled extensions claim no contribution ids; enabling one whose
  ids an active extension holds is refused), installs folders, serves extension assets
  (`asset_request`/`read_asset`, capped at `ASSET_LIMIT` while reading), checks permissions
  (`Registry::allowed`), stores per-extension JSON, builds ad-hoc terminals (`command_terminal`,
  `run_terminal`, launched with `context::extra_session_spec`), and assembles all extension context
  (`Registry::sections`: file sections read through `files::resolve`, then provider sections, within
  one `CONTEXT_BUDGET`, since `claude` gets the briefing as an argument). Keep this logic in core.
  The adapter's `Extensions` loads the `Registry` on first use, always on a blocking worker.
- `extensions.rs` contribution/registry types and `context.rs::ContextSection` ↔ `src/types.ts`;
  maintain these Rust/TS mirrors by hand. `packages/extension-api/index.d.ts` is the author API.
- `devices::load_devices(&Registry)` orders builtin < extension < user. `detect_with`,
  `detect_folder_with`, and `rescan_with` take extension detectors; original wrappers remain.
  All context/session builders now take `&[ContextSection]`.
- Backend commands ↔ `lib/ipc.ts`: `list_extensions`, `set_extension_enabled`, `reload_extensions`,
  `install_extension`, `reveal_extensions_dir`, `command_run`, `extension_terminal_run`,
  `extension_storage_get`, `extension_storage_set`, `extension_file_read`. Terminal/context
  commands accept optional `extraContext` for code providers, added to core-owned file sections.
  The frontend collects it only for agent terminals and briefings (`extensions/context.ts`);
  pop-outs ask the main window over `patchbay://context-request`/`-reply`, so every window gives
  an agent the same briefing. Extension commands, file I/O and the `patchbay-ext` protocol run
  off the main thread.
- `src/extensions/host.ts` owns hidden opaque-origin extension frames in the main window only.
  Source-bound JSON-RPC checks manifest permissions and limits sizes/concurrency/rate. A timed-out
  call only fails; a host is stopped after `MAX_TIMEOUTS` consecutive timeouts or a protocol
  violation. Calls made during an extension's own activation never wait on it. `terminals.run`
  names its session after the command, so repeats reuse it (at most `MAX_RUN_TERMINALS` per
  extension), and never takes the dock's focus. Hosts hear map edits debounced and without
  position-only changes. `bootstrap.js` is compiled into the backend's `patchbay-ext` protocol HTML; don't inject
  Tauri into it. The protocol only serves enabled extensions to the main webview and resolves
  assets canonically inside their folders. The IPC boundary is Tauri's invoke key, injected into
  top frames only (frames can reach `window.webkit.messageHandlers.ipc`; the smoke probe forges
  it); the null-Origin rejection is defense in depth. Keep capability remote origins absent. Visible views use separate sandboxed, CSP-restricted frames.
- `when.ts` parses declarative clauses without eval. `whenContext.ts` fetches filename sets through
  `list_dir`. Runtime extension terminals, badges, and rendered view HTML live only in UI state.
  Ad-hoc commands never mutate `patchbay.json`. Reload/disable/project switch disposes code hosts.
- `npm run smoke:extensions` uses `PATCHBAY_EXTENSIONS_DIR=examples/extensions` and the Docker
  fixture, checks contributions, palette launches, context, badges, views, iframe IPC denial
  (fetch and forged postMessage) and `terminals.run` reuse.
  Existing pop-out and view smoke checks must continue passing. Smoke handles stay debug-only.
