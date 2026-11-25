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

The Simple smoke uses disposable agents and worktrees. A planner replies and saves a plan, then the lead starts Build, Review, Fix, a follow-up Review, and Merge through its authenticated workflow requests. The smoke verifies that Chat stays open, that you can open stage terminals and inspect findings, and that a merge into main clears history without restarting the lead. The Stories smoke checks linkage at creation and the derived review label.

Manual checks with `npm run tauri dev` and hooks installed:

- Describe a feature in the main worktree and ask the lead to plan. Check the Markdown replies and saved plan. Create a worktree for the feature and ask its lead to build. Check that older plans appear collapsed.
- Ask the lead to review, fix findings, review again, and merge. Check the stage strip and merge outcome in Chat. In the regular Review view, verify that you can still change the review preset and base, and open the merge dialog.
- Open the terminal for a stage started by the lead. Check resizing and scrollback after switching to a regular view and back.
- Trigger a native permission request or AskUserQuestion. Verify the hook message, recipient and automatic drawer; a drawer opened manually stays open when the wait ends. Verify authority with a component pop-out focused.
- Ask Claude to use AskUserQuestion with two questions, and Codex in Plan mode to use request_user_input (and, outside Plan mode, to ask a clarifying question through request_user_input_async). Verify Chat shows every question and option, Send answer continues the agent without its terminal menu, Answer in terminal brings the menu up, and leaving it unanswered past two minutes falls back to the menu. After updating, reinstall hooks (Codex: trust them again in /hooks).
- With hooks reinstalled, have Claude and Codex each run a command that needs approval. Verify Chat shows the tool and command, Allow continues without the terminal dialog, Deny with a reason reaches the agent, Answer in terminal brings the dialog up, and a Codex setup with an automatic reviewer shows no card.
- While Claude and then Codex work, press Interrupt: the turn ends, the agent keeps running, the composer reads Ready and the next Send is delivered. Press Esc in the terminal instead, confirm "Not confirmed ready: Interrupt to send", then Interrupt and send.
- Scroll up while replies arrive; the timeline stays put. Scroll to the bottom and confirm it follows new replies. Notification View scrolls to the agent without leaving Chat.
- Plan a story while its board is open; the board and Chat stay open. Restart the planner, create a worktree, Build, Review and Merge. The story links on creation, progresses through building/review/merge and reaches Done after the merge. The pending-story chip can dismiss a story explicitly.
- Switch worktrees during slow startup or prompt delivery, restart the recipient, and interrupt a provider. Drafts survive and no prompt reaches another process generation.
- Rail view buttons and Cmd/Ctrl+2–4 open the requested Full view. Toggle Chat back on and confirm the conversation is retained. Test session service retirement from an older protocol with and without live work.
