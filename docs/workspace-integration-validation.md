# Workspace and integration validation

The implementation starts from `main` at `472338a`, the merged workspace continuity
foundation. Each roadmap stage has its own branch/worktree; `finish/workspace-integration`
combines them for integration checks.

## Continuity foundation (2026-10-06, macOS)

Verified against the merged baseline:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo test --workspace -- --test-threads=1`: 187 core, 3 CLI, and 2 native helper
  lifecycle tests passed. Provider resume tests use isolated executable/history fixtures.
- `npm run check` and `npm run build`
- `npm run smoke:workspace`: independent two-project identities, live pop-out, tab
  switches, planner/layout retention, and detached session discovery.
- `npm run smoke:lifecycle`: the same running counter survives quit/relaunch;
  tabs, drafts, viewport, planner scope and pop-outs restore; delayed extension work
  stays with its project; explicit draft recovery preserves externally edited maps;
  malformed recovery documents remain untouched.
- `npm run smoke:tasks`: parallel task/open-worktree terminals, task-aware badges/review,
  dirty-task removal refusal, and task removal preserving open-worktree processes.
- `npm run smoke:actions`: ordered startup/readiness, explicit stop, affected validation,
  result navigation, saved group configuration and membership cleanup.
- `npm run smoke:git`, `npm run smoke:extensions`, `npm run smoke:views`, and `npm run smoke`:
  live Git updates, sandboxed extension IPC/context/view/session reuse, review/context/shortcut
  flows, and pop-out backlog/live input/file-tree/tile behavior.

Added native helper regression `detached_task_environments_preserve_other_projects_and_shared_owners`
passed: four simultaneous project/task scopes with identical component/terminal/task IDs
retain distinct session identities and launch folders after client disconnection; releasing
one shared group owner preserves its process; releasing the last owner stops only that task.

Native watcher/socket/desktop checks need execution outside the restricted tool sandbox.
The sandboxed watcher test timed out and Vite could not bind its local port; the native
runs above passed with the required access. Smoke harnesses use private state directories
and shut down only their own session service.

## Release checks still requiring other hosts or accounts

- Native Windows and Linux packaged builds and desktop smoke flows.
- Real Claude/Codex prompt, permission, interruption and exact conversation resume flows.
- Multiple-display geometry and packaged editor/reporter execution on every advertised platform.
- A two-week developer trial after navigation and maintenance land. Record voluntary return
  separately from requested test sessions; do not infer adoption from automated smoke runs.

These gates remain required even when the macOS fixture-based checks pass.
