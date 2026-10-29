### Scheduler

The scheduler is being delivered in phases. Phase 1 supports **Keep going in background** in the
Auto dialog; queueing, automatic resume, timers and power/window controls are not implemented yet.
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
runs and resumable pauses into `restored`, and keeps input/approval waits as `needsUser`. A future
scheduler may resume only `restored`, `inactive` and `interrupted` pauses.

The Git watcher remains attached to each project's selected worktree (`task_activate` →
`ProjectAccess.task_root`). Auto reads worktrees, branch status and findings directly every five
seconds, independent of the UI's Git badges. No Rust↔TS command/type mirrors change in this phase;
`background`, `pauseKind` and `pausedMs` are frontend workspace fields. `smoke:auto` exercises the
full background plan/build/validate/review/merge path while another worktree remains selected.
