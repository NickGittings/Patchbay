# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Prerequisites: Rust (edition 2024, via rustup), Node.js (20.19+ on 20.x, 22.12+ on 22.x, or 24+).

```sh
# Desktop app (Tauri 2 + React)
cd apps/desktop && npm install
npm run tauri dev

# CLI (no UI) — useful for exercising core logic quickly
cargo run -p patchbay-cli -- detect .                  # suggested component map for a dir
cargo run -p patchbay-cli -- context patchbay-core     # agent briefing for a component
cargo run -p patchbay-cli -- plan crates-patchbay-core --dir . # planner briefing for a highlighted set

# Checks (run all before considering work done)
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo nextest run --workspace                          # or `cargo test --workspace` (install: cargo install cargo-nextest --locked)
(cd apps/desktop && npm run check)                     # tsc -b + oxlint src + prettier --check + vitest run
(cd apps/desktop && npm run smoke:all)                 # every smoke script against one build, then a pass/fail summary
(cd apps/desktop && npm run smoke)                     # one script: opens the app, drives a pop-out window, exits 0/1
(cd apps/desktop && npm run smoke:simple)              # map/chat, stage actions, activity and session recovery
(cd apps/desktop && npm run smoke:views)               # view switching, local planner lifecycle, changes and review
(cd apps/desktop && npm run smoke:git)                 # watcher signals and idle Git refresh behavior
(cd apps/desktop && npm run smoke:tasks)               # task worktrees on a scratch repo (smoke/tasks-fixture.sh)
(cd apps/desktop && npm run smoke:dependencies)        # first-save dependency detection, manifests then a fake agent
(cd apps/desktop && npm run smoke:stack)               # stack detection by a fake agent, reviewed in the Stack panel
(cd apps/desktop && node scripts/smoke-all.mjs views git --bail)  # a subset, stopping at the first failure
(cd apps/desktop && npm run screenshots)               # macOS: retake README screenshots (smoke/readme.js on the Northstar demo)

# Single test
cargo test -p patchbay-core context::tests::claude_gets_neighbour_dirs_and_context
cargo test -p patchbay-core detect                     # all tests matching "detect"
```

Rust unit tests live in `#[cfg(test)] mod tests` at the bottom of each core module (`.config/nextest.toml` caps the process-spawning ones). Frontend unit tests (Vitest, node environment) sit beside pure modules as `src/**/*.test.ts` and run in `npm run check`; mock `../store` and Tauri APIs rather than testing components. Values hashed or encoded on both sides (`sessionId`, `componentLabel`) are pinned to the same golden strings in a Rust and a TS test, so change both together.

Smoke tests require a desktop session. Stop `tauri dev` first: the launcher needs port 1420. Hooks (`src-tauri/src/smoke.rs`, `src/lib/smoke.ts`, `window.__patchbaySmoke`) must stay debug/dev-only; never add release-build test hooks. Smoke windows run in the background on macOS and never have focus, so do not write checks that wait for `document.hasFocus()`, focus events, terminal authority claims, focus-driven `terminal_seen`, or Git refresh on focus. Verify those manually. Tests use disposable fixture repositories and isolated state; never use the personal root map. [Smoke launcher internals](docs/architecture/smoke.md) covers fixtures, process groups and screenshot exceptions; read before changing the smoke harness.

## Lints and style

- Workspace lints (`Cargo.toml`): `unsafe_code = "forbid"` (the desktop adapter copies them with `deny` so macOS-only `writing_tools.rs` can allow the Objective-C calls that turn Writing Tools off), clippy `all` plus `cast_possible_truncation`/`cast_possible_wrap`/`cast_sign_loss` as warnings, and CI-style clippy runs with `-D warnings` — so these casts must be handled (`try_from`, or a targeted `#[allow]`). Public fallible fns carry `# Errors` / `# Panics` doc sections and pure getters `#[must_use]`.
- Frontend: Prettier (no semicolons, single quotes, width 100, trailing commas), oxlint with react/typescript plugins.
- `.editorconfig`: 2-space indent, 4 for `.rs`, LF.

## Architecture

Three Cargo workspace members plus a React frontend:

- `crates/patchbay-core` — all real logic, UI-agnostic (driven by the desktop app, the CLI, or a future server).
- `crates/patchbay-cli` — thin wrapper over core.
- `apps/desktop/src-tauri` — thin Tauri adapter: each `#[tauri::command]` in `src/lib.rs` maps to one core call. Keep logic out of here.
- `apps/desktop/src` — React 19 + React Flow canvas + xterm.js + zustand.

### Data flow: the frontend owns the project

The zustand store (`src/store.ts`) owns the map as React Flow nodes/edges; `toProject()` rebuilds the `Project` sent to commands, and `dirty` tracks unsaved map edits. The backend is stateless with respect to the map. `rescan_project`/`add_folder` return only additions for the frontend to append. Terminal processes and backlogs live in `patchbay-sessiond` (`session.rs`), reached through the desktop's `service::Bridge` with pooled loopback connections and an ordered input/resize writer; the service outlives the app.

Per-project backend `ProjectAccess { access, watcher, task_root }` owns trusted roots, external-folder grants, Git watchers and the active task worktree. Backend dialogs grant access; frontend `sync_roots` can only narrow it. Check canonical paths, exclude locked components from launches/briefings, and replace caller-provided project roots with `AccessSnapshot::trust`. Run filesystem and launch work on blocking workers without holding access locks. Protocol retirement must preserve the `Hello`/`Shutdown` wire format; never silently stop active older sessions.

[Data flow](docs/architecture/data-flow.md) details grants, command restrictions and service retirement; read before changing file access, project IPC or the session protocol.

### Keeping Rust and TS in sync

Types and commands are mirrored by hand; there is no codegen. Changing a model field, command, event or shared encoding means updating both sides and their paired golden tests. Paths below are relative to `crates/patchbay-core/src`, `apps/desktop/src-tauri/src`, or `apps/desktop/src` as appropriate.

- `model.rs` / `events.rs` / `devices.rs` (serde `camelCase`) ↔ `types.ts`.
- Tauri commands in `lib.rs` (`generate_handler!`) ↔ `lib/ipc.ts` wrappers; Tauri maps camelCase arguments to snake_case parameters.
- `service.rs::TERMINAL_EVENT` ↔ `lib/ipc.ts` `patchbay://terminal`; adapter `lib.rs` ↔ `lib/ipc.ts` `patchbay://git-dirty`.
- `status::Reply` ↔ `types.ts::Reply`; `TerminalEvent::Reply` / `pty::Snapshot.replies` / `last_reply` ↔ reply events / `TerminalSnapshot.replies` / `lastReply`.
- `plans::Plan.saved_ms` ↔ `PlanText.savedMs`; `proposals::Proposal.saved_ms` ↔ `PlannerProposal.savedMs`.
- `usage::{Window, ProviderUsage, Usage, StatusLine}` ↔ `types.ts::{UsageWindow, ProviderUsage, Usage, StatusLineCapture}`.
- `usage_read` / `usage_status_line_check` / `usage_status_line_configure` ↔ `usageRead` / `usageStatusLineCheck` / `usageStatusLineConfigure`.
- `status::{SessionStatus, AgentReport, AgentState}` ↔ the same names in `types.ts`; `TerminalEvent::Status` ↔ the `status` event.
- `pty::Snapshot` ↔ `TerminalSnapshot`; terminal start/exit events and snapshots share `startedMs` / `exitedMs`.
- `files::DirEntry` ↔ `DirEntry`; `git::{ChangedFile, ChangeKind, FileDiff, Review, Affected, Worktree}` ↔ the same names in `types.ts`.
- `model::{MERGE_SCOPE, REVIEW_SCOPE}` ↔ the same constants in `types.ts`; `reviews::{ReviewRequest, Findings, Reviewer}` ↔ `ReviewRequest` / `ReviewFindings` / `ReviewerStatus`.
- `review_agent_start` / `review_read` / `review_prune` ↔ `reviewAgentStart` / `reviewRead` / `reviewPrune`; `session::Metadata.{branch, lane}` ↔ `SessionRecord.metadata.{branch, lane}`.
- `model::MAP_SCOPE` (`@map`) / `link_proposals::MAP_TERMINAL` ↔ `types.ts` `MAP_SCOPE` / `MAP_AGENT_TERMINAL`.
- `link_proposals::{ProposedLink, Pending}` ↔ `ProposedLink` / `PendingLinks`; `detect_links` / `map_agent_start` / `map_links_read` / `map_links_clear` ↔ `detectLinks` / `mapAgentStart` / `mapLinksRead` / `mapLinksClear`.
- Adapter `agent_commands.rs` `patchbay://map-links` ↔ `lib/ipc.ts`; `model::{PLAN_SCOPE, PROJECT_SCOPE}` ↔ `types.ts` `PLAN_SCOPE` (`@plan`) / `PROJECT_SCOPE` (`@project`).
- `workspace::session_id` / `model::task_session_id` ↔ `types.ts` `sessionId`; `model::task_terminal` / `TASK_SEPARATOR` ↔ task terminal keys. Session ids are opaque: use recorded `Metadata` and frontend `sessionMetadata`, never parse hashes.
- `stories::{Story, StoryKind, StoryStatus, StoryDraft, StoryPatch}` ↔ the same names in `types.ts`; `story_list/create/update/remove` ↔ `storyList/Create/Update/Remove` in `lib/ipc.ts`.
- `tasks::{Task, TaskDraft, TaskPatch}` ↔ the same names in `types.ts`; `task_*` ↔ `task*` wrappers; `patchbay://tasks` is a frontend pop-out broadcast in `lib/windows.ts`.
- `context::Kickoff::{ImplementPlan, FixFindings, Plan, PlanStory}` ↔ `types.ts` `Kickoff` (`kind`, optional `reviewSession`, `subagents`); `review_fix_task` ↔ `reviewFixTask`.
- `Kickoff::ImplementPlan.subagents` / `context::MAX_SUBAGENTS` ↔ `Kickoff.subagents` / `types.ts` `MAX_SUBAGENTS` (8); valid settings come from `SUBAGENT_COUNTS` / `isSubagentCount`, checked on set and restore.
- `plan_read` / `plan_write` (`plans::Plan`) ↔ `planRead` / `planWrite` (`PlanText`); `terminal_start` / `component_context` optional `peers` ↔ `lib/plan.ts` `peersFor`.
- `reviews::{Severity, Severities, Verdict}` ↔ `Severity` / `Verdict` / `ReviewFindings.verdict`; findings start with `Verdict: clean | issues`, then severity `Counts` and tagged findings.
- `merges::MergeOutcome` / `merge_outcome` ↔ `MergeOutcome` / `mergeOutcome`; `git::Review.ahead` / optional `git_review.base` ↔ `Review.ahead` / `gitReview` base.
- `context::AutoBrief` ↔ `AutoBrief`; `plan_start` / `task_root_start` / `review_agent_start` / `merge_agent_start` optional `auto` ↔ `startTerminal` options `{ kickoff, auto }`.
- `extensions.rs` registry/contribution types / `context::ContextSection` ↔ `types.ts`; extension backend commands ↔ `lib/ipc.ts`; `packages/extension-api/index.d.ts` is the author API.

[Rust/TS sync details](docs/architecture/rust-ts-sync.md) preserves the full mirror behavior and contracts; read before changing any mirrored interface. The mirror index also links to topic docs for extension, Chat and detection contracts.

### Topic docs

Read the relevant topic before editing its area; paths and code identifiers in these docs are repository-relative.

- [core-modules](docs/architecture/core-modules.md): Core engine modules, sessions, reviews and agent context; read before changing core behavior.
- [plan-handoff](docs/architecture/plan-handoff.md): Shared plans, proposals and implement/fix kickoff behavior; read before changing planner handoffs.
- [dependency-and-stack-detection](docs/architecture/dependency-and-stack-detection.md): Manifest and agent-assisted dependency/stack discovery; read before changing detection or proposals.
- [graph-actions](docs/architecture/graph-actions.md): Graph action scope, execution and validation; read before changing action launches.
- [worktrees](docs/architecture/worktrees.md): Task worktrees, branch lifecycle and session ownership; read before changing task or worktree handling.
- [frontend-terminals](docs/architecture/frontend-terminals.md): Terminal mounting, replay, input authority and session reconciliation; read before changing terminal UI or transport.
- [views-and-auto](docs/architecture/views-and-auto.md): View state, role presets and Auto stage ownership/gates; read before changing views or Auto orchestration.
- [scheduler](docs/architecture/scheduler.md): Phase 1 background runs, planner ownership and driveability; read before changing scheduling or launch gates.
- [component-windows](docs/architecture/component-windows.md): Pop-out routing, project broadcasts and terminal authority; read before changing native windows.
- [extensions](docs/architecture/extensions.md): Extension registry, permissions, hosts and contribution APIs; read before changing extensions.
- [chat-mode](docs/architecture/chat-mode.md): Chat timeline, reply persistence, composer and queued prompts; read before changing Chat mode.
- [story-board](docs/architecture/story-board.md): Story hierarchy, planning, task linkage and derived status; read before changing stories.

## Maintaining these docs

Keep `CLAUDE.md` under 15,000 bytes (`wc -c CLAUDE.md`), with commands, shared rules and concise architecture pointers. Put new implementation details in the relevant `docs/architecture/<topic>.md`, updating that doc when behavior changes. Add a short pointer here for a new topic. Do not inline or automatically import the topic docs: agents should read only the areas they change.
