# Finish a task in the same worktree

Finish task… in the Chat menu confirms that all task agents will stop, saved history will
remain available, and shell terminals will stay open. It never merges, changes branches,
or removes a worktree. Finishing is user initiated, with no automatic history deletion.

Each project/worktree has a persistent work cycle. Existing saved workspaces use the empty
initial cycle, preserving their session identities. After finishing, agents include the new
cycle in their identity; shells retain their original identities. Chat opens empty with a
Task history link. The next message launches a fresh agent in the current checkout.

Task history lists completion time, the branch recorded when finishing began, and the first
retained user request. A finished task retains its Patchbay chat, workspace and Auto state,
plan/proposal artifacts, review findings, coordination records, and provider conversation IDs
and session references. Output stays in the existing session service history; this is not a
complete independent provider transcript. Native conversation resume still requires the
provider's retained history.

Archived agents retain View output and explicit Resume actions. Resume explains that the
agent runs against the worktree's current files and stays separate from the active task.
Archived agents do not participate in automatic selection, team recovery, workflow polling,
or canvas restoration. Their authenticated agent commands cannot mutate active task state.
The existing conversation reset is named Reset agent conversation and retains its tooltip.

## Recovery and concurrency

The session service persists finish intent under its launch lock before retiring coordination.
It rejects old-cycle launches and new work in a finishing scope. Coordination uses a file lock
shared by the desktop and session service. Authenticated commands finish before cleanup takes
their scope lock. Lead, workers, scanners, planners, reviewers, merge agents, and component
agents are included; legacy delegated workers are retained through their coordination records.
Ordinary shell/task processes and other projects/worktrees remain running.

Agent shutdown must be confirmed before completion. A stop or archive failure retains the
workspace and durable finish intent; retry resumes the same operation, including after a
restart. Artifacts are captured durably before removal. Repeating an acknowledged finish
returns its receipt instead of closing another cycle. The receipt is authoritative when a
restart occurs between finishing and saving the new UI workspace.

## Validation

- `cargo test --workspace` covers the durable journal, legacy/shell identities, every agent
  role, worktree/project isolation, pending launches, repeated finish calls, failed/incomplete
  shutdown, explicit archived resume alongside a fresh agent, and restart during cleanup.
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `npm run check` covers frontend cycle reset, failure/retry, restart recovery, preserved shell
  identities, new coordination after finishing, and the existing Chat/session tests.
- `node scripts/smoke-all.mjs chat-controls sessions` covers the confirmation, fresh Chat,
  saved history in the original directory, and a real agent stopped and archived in a separate
  worktree while its shell keeps running. The Sessions scenario verifies retained output and
  persisted history references.

For a native provider check, finish a task with lead and workers, restart Patchbay, inspect
Task history, then send a new request. Verify the new agent has no old plan, handoff, queue,
or review instructions. Explicitly resume an archived conversation and verify its session
identity remains archived while the fresh Chat recipient remains selected.

Review regressions additionally cover an authenticated worker command crossing its parent
cycle boundary, failed review sidecars without retained sessions, and archived Claude-style
review output remaining separate while a fresh review uses the original branch/lane path.
