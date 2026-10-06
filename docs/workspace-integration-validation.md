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

## Combined feature validation (2026-10-06, macOS arm64)

All four implementation branches are combined on `finish/workspace-integration`, in
`/private/tmp/patchbay-workspace-integration`. The user's `main` remains at the merged
continuity foundation; no feature changes were merged into it.

| Stage                                 | Branch                     | Implementation commits |
| ------------------------------------- | -------------------------- | ---------------------- |
| Editor navigation and file search     | `finish/editor-navigation` | `132625a`              |
| Reviewed map maintenance              | `finish/map-maintenance`   | `cce8201`, `a32efd9`   |
| Claude/Codex status hooks             | `finish/agent-status`      | `1457a75`              |
| Supported Docker and browser previews | `finish/docker-preview`    | `0774d5e`              |

Integration review preserved all stage commands/dialogs, schema 4 metadata, session history
launch folders, task-scoped extension terminals and native permissions. It also fixed two
cross-feature issues: editing a link label now retains detection provenance, and delayed
map edits synchronize the originating project's native access roots while its tab is
inactive. Both are covered by the combined maintenance smoke and backported to Stage 2.

Passed on the combined branch:

- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run check` and `npm run build` (the existing bundle-size advisory remains)
- `cargo test --workspace -- --test-threads=1`: 227 core, 3 CLI, 2 native desktop,
  3 helper lifecycle and 3 reporter process tests; all passed after desktop preparation
- `node extensions/tests.mjs`
- `npm run smoke:maintenance`, including relabeled provenance and inactive access invalidation
- `npm run smoke:navigation`, including task/review paths, terminal generation/history,
  safe editor arguments, ignored/tracked paths and stale requests
- `npm run smoke:status`, using isolated hook sources and the native reporter
- `npm run smoke:integrations`, including real helper URL summaries, native permission
  denial, nested task worktree reads/launches, retained hosts and explicit Docker failures
- `npm run smoke:actions`, `npm run smoke:tasks`, and `npm run smoke:extensions`
- `npm run smoke:lifecycle`, including all five quit/relaunch/recovery phases and the same
  detached process generation

These native runs use private fixture state and stop their own services. Run Cargo process
tests after desktop helper preparation, rather than concurrently: the development launcher
copies the helper into the executable path used by those tests.

Stage details and fixtures are documented in [editor navigation](editor-navigation-validation.md),
[map maintenance](map-maintenance.md), [agent status](agent-status-validation.md), and
[supported extensions](../extensions/README.md). The [developer trial protocol](developer-trial.md)
is prepared for use after navigation and maintenance land; the two-week trial has not run.

## Release checks still requiring other hosts or accounts

- Native Windows and Linux packaged builds and desktop smoke flows.
- Final release packaging on macOS and installed editor/reporter launch checks on all
  advertised platforms; development native/helper checks are not a release package check.
- Real Claude/Codex prompt, permission, interruption and exact conversation resume flows.
- Real Docker daemon Up/Down/Logs, container health and simultaneous Compose projects.
  The local daemon was unavailable; deterministic success fixtures and the actual native
  failure path passed.
- Multiple-display geometry and packaged editor/reporter execution on every advertised platform.
- A two-week developer trial after navigation and maintenance land. Record voluntary return
  separately from requested test sessions; do not infer adoption from automated smoke runs.

These gates remain required even when the macOS fixture-based checks pass.
