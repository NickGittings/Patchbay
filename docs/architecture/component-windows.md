### Component windows

The Windows/Linux main window uses a custom title bar: Project and Settings menus,
centered search, and minimize, maximize/restore, and close buttons. Only the main
window is undecorated. Component pop-outs retain native decorations. macOS keeps
native menus and its overlay title bar with traffic lights.

On Windows, `window_controls.rs` explicitly enables resizing, minimizing,
maximizing, and closing. After creation and geometry restoration, it checks the
effective flags and repairs mismatches, expecting decorations only on pop-outs.
These getters reflect cached flags; working controls still need a desktop check.

To validate on Windows and Linux:

- Check Project and Settings with no project, an open project, an unsaved map,
  and recovery required. Verify action order, titles, disabled states, and Save.
- Open both menus by keyboard, move with arrows, execute a command, and dismiss
  with Escape. Confirm focus returns and keyboard events do not reach terminals.
- At the minimum 900px window width, confirm menus, search, and window controls
  remain separate and search works.
- Minimize and restore from the taskbar; maximize and restore with the button;
  double-click and drag empty title-bar space; resize from each edge. Interactive
  elements must not drag or maximize the window.
- Quit and relaunch with restored and maximized geometry, then repeat controls.
- Open a component pop-out and confirm native chrome and controls still work.
  Close it and reopen it; close main with a pop-out open and confirm both close.
- On macOS, confirm native menus and traffic lights remain present in main and
  component windows. Windows maximize-hover Snap Layouts are outside this change.

Each component can open in a native window labelled `component-<hex-encoded id>` that loads `index.html?component=<id>`, built by the backend's `window_open` (so macOS gets a Writing Tools-free webview configuration, as the main window does); `main.tsx` routes that to `ComponentWindow` (Files/Changes tabs + every terminal tiled). Every webview is a separate JS context with its own store and xterm registry. The main window stays the owner of the project: a pop-out emits `patchbay://popout-ready`, and `lib/windows.ts` answers with `patchbay://project` and `patchbay://git`, re-broadcasting (debounced) on edits; pop-outs apply it with `syncProject`, which keeps session state. Closing the main window closes all pop-outs (`lib.rs` `on_window_event`), and opening another project closes them too. Terminal events go to the main window on `patchbay://terminal` and to a pop-out only on `patchbay://terminal/<its label>` (`service::Bridge::route`; `component_window_label` must match `componentLabel` in `windows.ts`, and `showsSession` filters which records a window hydrates). A session can be shown in several windows at once; `windows.ts` tracks the last-focused window across webviews, and a pane claims the session's authority (`terminal_attach` with `claim`, which types and sizes the PTY) when its window becomes visible or active, never on plain resizes (xterm `onData` only writes from visible, attached panes, and replayed output never replies). New window labels must match `component-*` in `capabilities/default.json`.
