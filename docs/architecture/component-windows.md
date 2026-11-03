### Component windows

On Windows, both window builders explicitly enable native decorations, resizing,
minimizing, maximizing, and closing (`window_controls.rs`). After creation (and
after restoring the main window's geometry), the backend logs Tauri's effective
flags and repairs any disabled flags. These getters reflect Tao's cached window
flags, not a visual or Win32 style inspection. macOS keeps its overlay title bar.

Windows verification is still required: the inspected defaults already enable
these flags, the overlay configuration is only applied on macOS, and no code was
found that disables them. Explicit settings alone do not confirm a fix.

To validate on a Windows desktop:

- Launch the app and open a component pop-out. Capture the `Windows controls`
  diagnostics for both windows before interacting with them.
- Confirm both windows show native minimize, maximize, and close buttons. Minimize
  and restore from the taskbar; maximize and use the restore button; double-click
  the title bar; drag each window's edges to resize.
- Close a pop-out and reopen it. Maximize both windows, quit, then relaunch with
  saved geometry. Repeat the button, title-bar, and resize checks after restoring.
- Close the pop-out with its native close button, then close the main window with
  a pop-out open and confirm the app closes both.

If all logged flags are enabled but buttons remain absent, investigate the native
Windows styles or rendering before treating the issue as resolved.

Each component can open in a native window labelled `component-<hex-encoded id>` that loads `index.html?component=<id>`, built by the backend's `window_open` (so macOS gets a Writing Tools-free webview configuration, as the main window does); `main.tsx` routes that to `ComponentWindow` (Files/Changes tabs + every terminal tiled). Every webview is a separate JS context with its own store and xterm registry. The main window stays the owner of the project: a pop-out emits `patchbay://popout-ready`, and `lib/windows.ts` answers with `patchbay://project` and `patchbay://git`, re-broadcasting (debounced) on edits; pop-outs apply it with `syncProject`, which keeps session state. Closing the main window closes all pop-outs (`lib.rs` `on_window_event`), and opening another project closes them too. Terminal events go to the main window on `patchbay://terminal` and to a pop-out only on `patchbay://terminal/<its label>` (`service::Bridge::route`; `component_window_label` must match `componentLabel` in `windows.ts`, and `showsSession` filters which records a window hydrates). A session can be shown in several windows at once; `windows.ts` tracks the last-focused window across webviews, and a pane claims the session's authority (`terminal_attach` with `claim`, which types and sizes the PTY) when its window becomes visible or active, never on plain resizes (xterm `onData` only writes from visible, attached panes, and replayed output never replies). New window labels must match `component-*` in `capabilities/default.json`.
