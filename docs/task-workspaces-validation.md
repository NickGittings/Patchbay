# Task workspaces: plan audit and validation

Audited on 2026-10-07 on `task-agent-workspaces` against the supplied “Task workspaces with isolated worktrees and agent controls” plan. The existing task-workspace implementation was the starting point.

## Requirement coverage

| Plan area                       | Implementation and evidence                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Goal tabs and checkout identity | `WorktreePicker`, `NewTaskDialog`, and core `tasks.rs`: goal titles, default immediate worktree creation, current/existing checkout attachment, canonical checkout uniqueness, unavailable tasks, and open-checkout removal protection. Rust task tests and task smoke cover these paths.                                                  |
| Task state and compatibility    | `store.ts`, `workspace.ts`, and `taskWorkspaces.test.ts`: scope, terminal visibility, splits, focus and maximize restore per project/task; legacy state migrates to the active task. Existing session IDs remain intact and Sessions retains legacy processes.                                                                             |
| Terminal workspace              | `ImplementationView`, `TaskTerminals`, and `taskTerminals.ts`: root and component sessions share a task view; component names are labels and optional scope controls. Root shells start stopped. Root/component terminal locations and optional component agents remain available.                                                         |
| Planner handoff                 | `PlanView`, core `proposals.rs`, and `context.rs`: explicit application of versioned proposals, ID/assignment validation, ordered assignments, Markdown compatibility, assignment invalidation, and distinct planner/root implementation scopes. Provider briefing tests cover Claude and Codex.                                           |
| Agent control                   | Core `agent_bridge.rs`, CLI agent commands, desktop `agent_commands.rs`: authenticated launch-bound contexts, configured actions through shared handlers, task-local logs/activity, background results, missing-validator reports, cancellation and retained service processes. Bridge tests and task/action/session smoke exercise these. |
| Packaging                       | Tauri bundles the CLI beside the desktop executable and session service. The built app bundle contains executable `patchbay`, and its `agent --help` lists all planned commands. Task smoke exercises injected CLI discovery and real bridge requests in the debug app.                                                                    |

## Corrections from this audit

- Replaced the separate component pill row with a collapsed Component scope control inside the task.
- Agent action planning now retains inaccessible consumers and group members until required-folder validation rejects them. The task smoke regression checks both validation traversal and environment membership.
- Validation activity reports failure when validators are missing.
- Adding root/component terminals reveals them despite an explicit visibility filter or an existing maximized terminal. Starting an existing root implementation agent also reveals and focuses it.
- Shell and Custom terminal selections now create the appropriate terminal kind at either launch location.
- Hiding a tile accounts for running component sessions outside the selected scope.

## Verification

- `cargo test --workspace -- --test-threads=1`: passed (273 tests across workspace targets).
- `cargo fmt --all -- --check`: passed.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `npm run check`: passed (99 frontend tests and 2 smoke fixture tests).
- `npm run build`: passed.
- Desktop smoke: tasks, actions, sessions and views passed. Tasks and views were rerun after final changes.
- `npm run tauri build -- --bundles app`: passed.
- Executed the bundled `Patchbay.app/Contents/MacOS/patchbay agent --help`: passed.

The sandbox denied local socket binding, so Rust tests and desktop smoke were run with elevated execution access. An existing Vite server was confirmed to serve this checkout; an external temporary runner reused it with the standard isolated smoke fixtures without stopping that server.

Manual verification still needed: click a detected preview URL and confirm it opens in the user's browser; launch an agent from the release app and confirm its injected CLI path. Preview URL detection and debug-agent CLI invocation passed automated smoke, but those do not establish either manual release-app check.
