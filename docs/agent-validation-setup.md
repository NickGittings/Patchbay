# Agent-assisted validation setup

Open **Run → Set up validation → Configure checks with an agent…**. Choose at least one
component and an agent preset. The picker starts with the canvas selection. Discovery reads
existing documentation, scripts and configuration; its briefing excludes running checks,
repository edits, installation, setup, watchers, servers and automatic fixes.

Review each proposed command, component execution folder and source evidence. Checks start
selected. Components without suitable checks have an explanation, including missing prerequisites.
**Apply** adds task terminals or assigns matching unassigned task terminals to Validation.
**Apply and run** also runs every configured validator for the selected components in the captured
active worktree, without traversing dependents. Failed checks keep the applied configuration.
Existing affected-component validation and Auto retain their existing traversal.

Applications use normal map edits and save conflict handling. A project without `patchbay.json`
keeps the existing **Create map configuration** flow. Changed folders, removed terminals,
changed commands and assigned terminal roles are left unapplied with an explanation. Retrying
an application reuses matching validators. Pending reports survive desktop restarts, and clearing
an old report preserves any newer submission.

The discovery role may submit `agent propose-validation --file <path|->`; it cannot start graph
actions. The session service retains the selected component IDs with the launch and checks every
submission against them and the project's existing folder permissions. Discovery only adds
selected external component folders to the agent's folder access. Implementation agents can use
`agent validate-selected <componentId> [componentId…]` when downstream checks are unnecessary.

Verification:

- `npm run check` and `npm run build` in `apps/desktop`.
- `cargo fmt --all -- --check`, workspace Clippy and workspace tests.
- `node scripts/smoke-all.mjs validation` in `apps/desktop` exercises the actual desktop picker,
  authenticated discovery submission, evidence review and failed first run, checking that a
  dependent component is excluded and configuration is retained.
- Core regression tests cover monorepo and external working folders, selection enforcement,
  missing-check reports, persistence, submission-aware clearing, failures and cancellation.
- Frontend regression tests cover additive edits, stale folders and commands, duplicate
  prevention, project switching, report recovery and Apply versus Apply and run.

The desktop smoke test uses a deterministic discovery agent fixture. Discovery with real agent
providers across separate repositories still needs hands-on acceptance testing.
