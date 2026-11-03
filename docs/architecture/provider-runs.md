# Provider runs

Agent roles now include optional Scan and Workers selections. Plan remains a single preset;
Implement is the coordinator when Workers is nonempty. Empty selections preserve the existing
single-agent workflows. Provider-native subagents are disabled in coordinated builds.

In Plan, enter a scan goal and choose **Scan and plan**. Every selected installed scanner receives
the same goal and scope and investigates without changing source. Reports require an authenticated
`agent scan-report --file <json>` submission containing `references`, `findings`, `uncertainties`,
and `suggestedWork`. A stopped or idle scanner without a report fails. Retry preserves completed
reports; **Continue with available findings** explicitly accepts a partial round. Starting the
planner includes the attributed reports and disagreements. Goal, scope, branch, committed revision,
local edits and untracked contents are checked again before handoff.

Accepting a plan with workers selected starts the Implement coordinator in the target checkout.
The target must be clean. The coordinator uses these authenticated commands:

- `agent assignments-create --file <json>` takes an array of records with `id`, `instructions`,
  `components`, `dependencies`, and a selected worker `preset`.
- `agent assignments-seal` closes the assignment list.
- `agent assignments` inspects the owning run, job states and results.
- `agent assignment-integrate <id>` merges a submitted result serially into the target.

Assignments have unique IDs and acyclic dependencies. Each worker gets its own task, branch and
worktree, seeded from the latest integrated target HEAD when its prerequisites are integrated.
Independent workers run concurrently. Workers commit and submit
`agent worker-result --commit <HEAD> --summary <text>`. Dirty results, unchanged base revisions,
foreign sessions, unselected presets and assignments outside the selected scope are rejected.
Coordinated implementation requires components in the target repository.

Integration uses merges so worker commits remain ancestors of the target, enabling recovery after
a lost reply. A durable journal precedes each merge. On conflicts, the target stays available for
the coordinator to resolve and commit; repeating integration adopts the resolved merge. Validation
and review wait for the sealed assignment list to be completely integrated. Build shows provider,
assignment, status, report, terminal, commit, and integration result. Worker tasks and branches remain
until the user removes them through the existing task controls.

Auto optionally starts with Scan and reserves the project's planner through plan acceptance. Its
saved state retains scanner and worker selections and the provider-run IDs. Pausing stops new
scheduling while retaining sessions; Stop cancels owned sessions and preserves artifacts. After app
restart, unfinished runs restore paused and reconcile service records before launching anything.
Launch request IDs are stored before spawn, and retries of uncertain launches reuse their IDs.
Session samples taken before a launch cannot fail that launch. The session service protocol is 16,
which retains briefings for the three new job roles and provides a dedicated operation to recover
planner scan options on restart without exposing the launch environment.

Core records live in `<git-common-dir>/patchbay/orchestration.json`, separately from review rounds
and verdicts. The desktop exposes typed run creation, inspection, control and launch IPC. The agent
bridge fixes project, run membership and role from the authenticated session; agents cannot select
another run in command arguments.

Run `npm run smoke:providers` from `apps/desktop` for the fake-provider scan, plan, worker,
integration, validation and review flow. `npm run smoke:auto` retains coverage of the single-agent
Auto path. Unit coverage includes ownership, staleness, dependencies, worktree isolation, clean
checks, partial failures, launch reconciliation, cancellation, restoration and merge recovery.
