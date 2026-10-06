# Editor navigation validation

Stage 1 adds machine-local editor preferences, explicit task/worktree native navigation,
Git-aware path search, and modifier-click terminal locations. It preserves interactive CLIs,
the map, project drafts, and existing command-palette behavior.

## Automated checks

- Core navigation tests exercise literal custom executable arguments (including spaces,
  quotes, shell punctuation and placeholder-looking filenames), line/column parsing,
  missing launcher guidance, bounded/noisy login-shell PATH probes, tracked ignored files, ignored untracked files, independent
  sibling grants, denied roots, symlink escapes, filename ranking, and the 100-result cap.
- `npm run smoke:navigation` creates an isolated Git fixture and state directory. It drives
  native editor commands through a fake Unix editor, verifies arguments through a live PTY,
  checks generations and recorded-directory failures, exercises real xterm drag selection and
  Ctrl-click, soft-wrapped Unicode references, and scrollback generation retention after restart.
  It also verifies task/explicit review worktree file targets, stale task search disposal, quick
  search, and the unavailable-editor settings explanation.
- A native regression verifies a nested project root maps to a registered task and explicit
  review worktree while sibling grants stay confined. Session regression verifies stop → folder
  repair → relaunch retains the original historical launch folder. Current legacy snapshots can
  recover their folder from their record; older legacy history stays explicitly unknown.
- Existing task, Git, workspace, action and pop-out smoke suites remain applicable because
  navigation commands retain their originating project/task identities.

## Recorded validation (macOS, 2026-10-06)

Rust formatting, workspace Clippy with warnings denied, workspace tests, frontend check/build,
and the native navigation desktop flow passed. Workspace tests require native filesystem/process
access here: the existing watcher lifecycle test times out under the sandbox and passes outside it.
The frontend build retains its existing large-bundle advisory.

## Platform release checks still required

Validate packaged VS Code/Cursor/Zed launchers on macOS, Windows and Linux, including Dock/start
menu launches with login PATH differences, Windows per-user/system installations, Zed installation
variants, missing editor installations, and custom executables with spaces/punctuation. Windows
batch files are intentionally not accepted as custom executables: configure the editor `.exe`.

Check task worktrees, nested project roots, nested repositories, approved sibling repositories,
revoked access and symlink replacement. Check explicit review worktrees while another task is active,
file-tree double-click and separate reveal actions in pop-outs, and rapid query/project/task changes.

Check macOS Cmd-click, Windows/Linux Ctrl-click, terminal normal drag and word selection, Unicode
wide/combining paths, filenames with quotes/spaces, and terminal links following reconnect/restart.
References are reconstructed across soft-wrapped terminal lines. No provider hook setup or real-provider readiness is established by
navigation tests.
