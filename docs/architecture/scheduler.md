### Scheduler

The scheduler supports **Keep going in background**, opt-in **Resume when usage resets**, and
one-time **Resume at** schedules for paused Auto runs. Recurring schedules, delayed initial starts,
standalone agent scheduling, queueing and power/window controls are not implemented.
`AutoRun.background` is per-run workspace UI state, restored by `restoredAuto`, never map data or
`dirty`. `driveable` allows an active worktree or a background run whose project remains open in
`projectOrder`. The main window's existing `followAuto` drives every open project. It still needs
the app running; this adds no headless service or macOS LaunchAgent, nor a keep-awake guarantee.

Auto passes project/worktree targets to planner and review handoffs. Background runs and Simple
mode use `presentation: 'stay'`; foreground Full mode follows the new agent into Build.
`addRootTerminal(device, target)` adds a terminal to that workspace without selecting it. Auto's
project-wide planner uses the requested worktree's highlights. A project has one Auto planner turn,
acquired immediately before launching or adopting a planner and held until implementation has
accepted the shared plan. `AutoRun.plannerTurn` persists ownership across Resume and restart;
snapshot reads never reserve a turn. Other runs stay Running with "Waiting for the planner",
including while the owner is paused, and continue when it releases the turn. A run that never
acquired a planner holds no turn.

`AutoRun.pauseKind` distinguishes `user`, `restored`, `inactive`, `interrupted` and `needsUser`;
`pausedMs` records when the pause began. Pause defaults to `user`; transient validation and Git
failures use `interrupted`. Launch errors become `failed`, including an unconfirmed launch during
a disconnect, so reconnect never retries a possibly running agent. Invalid configuration, branch
changes, competing agents, broken/superseded review rounds and unreadable artifacts pause as
`needsUser`. Only `needsUser` pauses appear in Attention; other pause kinds stay quiet. Service
disconnection defers new launches until reconciliation reconnects. Completed stage transitions and
validation results still save during a disconnect, so driving continues from the completed work. Resume clears pause metadata; restore preserves an existing
pause timestamp.
Restore preserves `user`/`needsUser` pauses (legacy unclassified pauses count as user), turns active
runs and resumable pauses into `restored`, and keeps input/approval waits as `needsUser`. The scheduler resumes only explicit `usage` and `scheduled` pauses with a persisted trigger;
ordinary restored, inactive and interrupted runs still require manual Resume.

The Git watcher remains attached to each project's selected worktree (`task_activate` →
`ProjectAccess.task_root`). Auto reads worktrees, branch status and findings directly every five
seconds, independent of the UI's Git badges. No Rust↔TS command/type mirrors change in this phase;
`background`, `pauseKind` and `pausedMs` are frontend workspace fields. `smoke:auto` exercises the
full background plan/build/validate/review/merge path while another worktree remains selected.

### Scheduled resume

`AutoRun.resumeOnUsageReset` defaults to false. The existing launch usage gate records a `usage`
pause and structured `usageWait` (required providers and latest blocking reset). Opted-in runs
also record `resumeTrigger: { kind: 'usage', atMs }`. Before resuming, usage is refreshed; all
blocking provider windows must clear. Extended reset deadlines update the pending trigger.
Missing or expired windows retain the existing allow-through behavior. This covers the existing
gate only: it does not add gates to scan/worker launches or detect mid-turn rate-limit failures.

Paused runs without a needs-user issue can choose a future local date/time. This records a
`scheduled` pause and a `time` trigger, replacing a pending usage trigger. Only one trigger exists
per run. At the chosen time the normal launch gate still applies; if usage blocks again, the
per-run usage preference determines whether another automatic wait is created.

Triggers are workspace UI state, restored only alongside compatible pause metadata. Legacy runs
receive no schedules. Due triggers execute once on reopening or waking when the project remains
open, the service has reconciled, and foreground/background permission allows work. The main
window controller serializes scheduled resume with normal driving, checks every five seconds and
on focus/reconnect, and reuses Resume's ownership, branch, hook and session checks. No computer
wake or keep-awake behavior is added.

Manual Resume, Pause, Stop and Skip cancel the pending trigger. Cancelling a schedule leaves the
run paused. Async checks verify the run still matches before acting. Authentication failures
require manual attention without opening a setup dialog; other resume failures also cancel the
trigger and explain the issue. Scheduling does not grant merge approval or answer input prompts.
The Auto panel (including Simple mode) displays the date/time/timezone, edit/cancel controls and
app/background requirements; the run activity log records scheduling and resume actions.
