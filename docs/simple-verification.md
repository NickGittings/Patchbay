# Simple mode verification

The initial implementation budget was three to four weeks. Terminal ownership and session recovery were inspected in the first increment; the code is delivered in four reviewable commits on `simple-mode`.

Automated checks include pure thread/recipient derivation, shared planner isolation, complete workspace log restoration, legacy panel sizing, readiness and send cancellation, exact bracketed paste, mention token edits, failed writes, activity hydration races, path ownership and shared diff grouping. Rust coverage includes provider normalization and Unicode bounds, accepted/rejected activity, retention, final journal draining, snapshot serialization and stable retirement wire format. `smoke/simple.js` uses disposable worktrees and fake local agents without model calls.

Run:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace
(cd apps/desktop && npm run check)
(cd apps/desktop && npm run smoke:all)
```

Automated results for the completed implementation:

| Check | Result |
| --- | --- |
| Rust formatting | Passed |
| Clippy, all targets, warnings denied | Passed |
| Workspace nextest | 461 passed |
| Desktop check | 646 Vitest tests and 2 fixture tests passed; TypeScript, Oxlint and Prettier completed |
| Desktop smoke suite | 20/20 passed, including Simple, pop-out, sessions, lifecycle and navigation |

The following checks require an interactive desktop session. They have not been established by the background smoke suite:

- With Simple enabled, send to a ready planner, then repeat with a component pop-out focused. Verify only the intended focused viewer controls typing and PTY sizing.
- Expand/collapse an inline terminal, scroll it out of view, switch to its Full view and dock/pop-out, then return. Verify hidden hosts do not reclaim it and scrollback stays intact.
- Trigger a real provider permission request. Verify the terminal expands once, Send is disabled, the draft stays intact and answers go through the provider's native terminal UI.
- With Agent status integration not installed, open a Claude or Codex recipient. Verify Send stays disabled with “Chat needs agent status integration”, also while a permission dialog sits quietly.
- Switch worktrees or recipients during slow startup, restart/exit the recipient during a claim and toggle Simple off during a pending send. Verify cancellation preserves the draft and sends no prompt to a replacement generation.
- Resize and collapse the chat, Inspector and dock, restore Show chat, and toggle Full/Simple. Verify independent saved widths, map viewport continuity and sensible minimum sizes.
- Use Cmd/Ctrl+2–4 from the composer and terminals. Verify Simple closes, the requested Full view opens, and toggling Simple off ordinarily restores the last Full view.
- Open findings/activity file references with and without diffs, including nested and external components. Verify the exact worktree/file and line are retained; missing files never redirect to another diff.
- Run Simple Auto with several role-selected agents. Verify unsupported integrations offer installation, Light/ask-to-merge settings, pause/resume/stop ownership and the existing merge approval behavior.
