# Chat mode verification

Automated coverage includes the pure flow prompt table (manual and Auto), chronological agent grouping, reply deduplication/restoration, stale plans, story progress, immediate worktree linkage, planner restart retention and handoff linkage without resetting the story baseline. Rust tests cover Stop reply normalization and UTF-8 caps, Tracker identity checks and retention, final journal drain/snapshot round-trip, plan mtime and clean/conflicting scratch repositories.

Run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace
(cd apps/desktop && npm run check)
(cd apps/desktop && node scripts/smoke-all.mjs simple stories views auto)
```

The Simple smoke uses disposable agents and worktrees, without model calls: prompt → planner reply → plan → Build/new worktree → build completion → Review → findings → Fix → conflict check → Merge → merged. The follow-up review after fixes verifies reuse of interactive reviewer sessions. It checks Chat stays open, the open composer drawer switches from planner to builder, input waits open it automatically, and replies survive saved workspace/remount. The Stories smoke checks linking at creation and the derived review label.

Manual checks with `npm run tauri dev` and hooks installed:

- Describe a feature in the main worktree. See the planner's Markdown replies and current saved plan. Build into a new worktree; the conversation continues there. Older project plans remain collapsed and cannot enable Build.
- Complete review, fixes, conflict check and merge in Chat. Verify review Options can change presets/base. Check both conflicting and clean branches, and merge anyway after issues.
- Leave View terminal open while starting Build or Review. Verify it follows the composer recipient, resizing works, and scrollback survives switching to Full and back.
- Trigger a native permission request or AskUserQuestion. Verify the hook message, recipient and automatic drawer; a drawer opened manually stays open when the wait ends. Verify authority with a component pop-out focused.
- Scroll up while replies arrive; the timeline stays put. Scroll to the bottom and confirm it follows new replies. Notification View scrolls to the agent without leaving Chat.
- Plan a story while its board is open; the board and Chat stay open. Restart the planner, create a worktree, Build, Review and Merge. The story links on creation, progresses through building/review/merge and reaches Done after the merge. The pending-story chip can dismiss a story explicitly.
- Switch worktrees during slow startup or prompt delivery, restart the recipient, and interrupt a provider. Drafts survive and no prompt reaches another process generation.
- Rail view buttons and Cmd/Ctrl+2–4 open the requested Full view. Toggle Chat back on and confirm the conversation is retained. Test session service retirement from an older protocol with and without live work.
