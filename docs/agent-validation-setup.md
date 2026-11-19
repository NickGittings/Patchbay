# Run & test setup with an agent

One detection agent works out how to prepare, run and test a project in a worktree: the
Development terminals a stack starts, the one-shot checks that validate each component, optional
worktree preparation, and what two copies of the app running at once would share. It submits
everything as one version 2 proposal (`agent propose-stack --file -`), reviewed in the Stack panel.

Start it from either place:

- **Stack panel → Run & test detection → Detect run & test setup** (optionally targeting a stack
  to replace).
- **Run → Set up validation → Configure checks with an agent…**, which picks components first. The
  selection narrows only the checks; the rest of the proposal covers the whole map.

The review lists Development changes, checks with their execution folder and evidence, why
components have no checks, worktree setup, and the parallel-instance resources and blockers.
**Apply** makes one ordinary map edit: Development startup, Validation terminals, worktree
preparation and `Project.instances` (`parallelSafe`, notes). **Apply and run checks** also runs the
applied components' validators in the active worktree, without traversing dependents. **Discard**
changes nothing. Changed folders, removed terminals, changed commands and assigned roles are left
unapplied with an explanation.

## Parallel instances

Every component terminal and worktree preparation gets `PATCHBAY_INSTANCE` (0 in the main
checkout, the lowest free number from 1 per task), `PATCHBAY_INSTANCE_ID` (`main` or the task id),
`PATCHBAY_PROJECT_ROOT` and `PATCHBAY_WORKTREE_ROOT`. Detected commands derive ports, database and
compose project names from them with shell defaults, so the main checkout behaves as before, for
example `PORT=$((3000 + ${PATCHBAY_INSTANCE:-0}*10))`. Patchbay does no templating. When
`instances.parallelSafe` is set, environment starts and validations run per checkout at once;
otherwise one at a time per project.

## Secret files

The briefing forbids opening or searching `.env`, `.env.*`, keys, certificates, credentials and
similar files; templates (`.env.example`, `.sample`, `.template`) may be read for variable names.
Detection sessions carry `PATCHBAY_SECRET_GUARD=1`, and the Claude/Codex `PreToolUse` hook denies
file tools on matching paths or globs and shell commands that name them or search hidden or
ignored files. Shell matching is best effort: quoting, variables and substitutions can hide a path.
It relies on the provider hook integration being enabled. Worktree preparation may copy secret
files from `$PATCHBAY_PROJECT_ROOT` without reading them; per-instance overrides go in a generated
file the app's loader reads after `.env`, never in edits to `.env`.

## Agents set it up themselves

When an agent runs `agent validate…` or `agent environment start` in a project that was never
detected (no `instances.detected`) and has nothing of that kind configured (no Validation terminal
anywhere for a validation that covers components, or no stack at all), Patchbay starts the detection with the agent's provider and applies the result
without review. Agents in other worktrees asking meanwhile join the same detection. The CLI prints
progress lines and waits up to 15 minutes; on failure, timeout or a fallback to review it reports
why and the original request runs with the current configuration. After applying, the detected
worktree preparation is enabled and run in the asking worktree, and the request continues; a
preparation that fails or outlives 10 minutes is marked skipped there, so it never blocks that
worktree's agents. A detection already running or waiting for review answers the agent at once,
and a proposal whose save fails is taken back and left for review. A toast offers **Undo**
(restores what is unchanged since, re-enables the preparation command enabled before or disables
it, and keeps the project marked detected) and **Review** (the applied proposal, read-only).
Restarting the detection terminal by hand gives a reviewed proposal unless an agent still waits. Discarding an
agent-triggered proposal that fell back to review also marks the project detected. The Stack
panel's **Let agents set up run & test automatically** (workspace layout, on by default) turns
this off; agents then get the old result with a hint.

Pending submissions left by the retired standalone discovery (`propose-validation`) still get one
last review under Run → Set up validation; the command itself now fails with a pointer to
`propose-stack`.

Verification: `smoke:stack` and `node scripts/smoke-all.mjs validation` cover detection with checks
from the Run entry, retained selection on restart, Apply and run checks, and two checkouts running
at once with distinct `PATCHBAY_INSTANCE` values. Detection with real providers, the secret guard
and automatic setup need hands-on acceptance testing.
