### Chat mode (opt-in)

The rail's **Chat mode** toggle (`simpleMode`) opens one worktree conversation beside Navigation's read-only map or story board. The last Full view stays saved. Rail view buttons and Cmd/Ctrl+1–4 leave Chat for the requested Full view. Story Plan and notification View stay in Chat. `revealTerminal` selects the related worktree/session and scrolls to that agent's latest block without changing views. Chat uses independent `App-simple` / `App-simple-open` panel sizing; old Navigation layouts gain a collapsed chat slot through `simplePanelLayout`.

`lib/simple.ts::thread` projects a chronological timeline, grouping consecutive prompts and replies under plain agent headers. `sections` groups stage attempts, collapsing older steps to role, summary and time while the latest stays expanded; revealing a session opens its section. `lib/simpleFlow.ts::flow` scripts planning, build, review, fix and merge narration and prompts from sessions, actions, artifacts and Auto state. `chatStepper` projects the step `chatStatus` picks onto the Plan → Build → Review → Merge strip at the top of Chat's status area, above Work status (fix counts as a pass inside Review; a review verdict's issue count sets its note; an active run in place drops Merge). A stage waiting for your go is `ready` (accent); one waiting because of a problem (issues, no verdict) is `attention` (amber). A paused or failed Auto run, or a paused or stopped team, marks the stage in progress `stopped`/`failed`; Auto's reason is the note and Pause Auto sits beside the strip, replacing a separate Auto line. It reuses the Auto panel's `auto-stepper` state styles and is hidden while the step is `idle` and Auto is not running, paused or failed. Simple calls no model. Agents' final messages come directly from Stop hook `last_assistant_message`, capped at `agent_hooks::REPLY_LIMIT` (16 KiB) on a UTF-8 character boundary. `Tracker` accepts replies under its generation, journal sequence, conversation and turn checks, retaining the newest 20 and emitting `TerminalEvent::Reply` while the process runs; each event names the sequence of the run's previous reply (`previous` ↔ `TerminalEvent` `previous`, null for the first). `Snapshot.replies` restores this window. Session lists carry only `lastReply`; `sessions.ts` remembers per session how far this window's replies are complete (`replySnapshots`), extends that with a live reply whose `previous` is the covered one, and reads a snapshot (`fetchReplies`, through `sessionFromSnapshot`, the one snapshot→`SessionState` conversion, which takes a listing's `interrupted` only for the run it lists) only when `lastReply` is past it. Session protocol 11 added replies, 12 their `previous`, and 13 explicit forced prompts (this checkout already used 10 for activity/prompts); the retirement handshake handles older services.

`TaskWorkspace.simple` holds `{ startedMs, log }`, including the project-folder workspace keyed by `''`. Prompt entries retain exact transmitted text, mentions, session and generation; only prompts and entries that start or resume a run (plan, implement, review, fix, merge, resume) may claim it, never Auto controls. A launch's entry goes through `simpleActions.ts` `logLaunch` with its launch request id (`startTerminal` resolves to it once the session started, the handoffs return it beside the session id, reviewers carry theirs, and resume and merge pass their own): `launchedRun` claims the run of the record whose latest `requestIds` entry is that request, from the store's records, else the service's list (applied to the store when newer), and otherwise no run; no clock is compared, so a stopped, pre-launch or later run is never claimed. Chat resumes log their claim before reconciling and then persist the replies already held. `SimpleState.version` (`SIMPLE_VERSION`) marks logs saved by this scheme; restoring an older one gives each run-less claiming entry the run of its session's next entry naming one, in `boundedSimpleLog`'s order, else none (`restoredSimple`). Prompts and successful actions are retained in the conversation log. Reply text is capped at 16 KiB per reply and 128 KiB per chat, retaining the newest replies (`boundedSimpleLog`, which orders the log by time and journal identity first). For chats that have never been cleared, no cursors are persisted: a reply evicted by the budget is older than every retained one, so re-adding it after a restart (from a snapshot's last 20) trims it again and `logSimple` leaves the log unchanged; `thread` applies the same bound to the replies it merges. `simpleReplies.ts` persists replies during ingestion even while Chat is unmounted, deduplicating by session/generation/sequence; reconciliation repeats it for a shown session only when its key (run, reply sequences and receiving chats, `persistChangedReplies`) changed since the last pass. Scoped planner replies enter only their worktree. Historical shared planner replies enter only conversations that used that run (`ownsPlanner`: a claiming entry with that exact generation; an entry without one claims no run), and only such a run shows in a chat's thread or takes over its recipient with an input wait (`thread`'s `foreign`, passed to `selectRecipient`); another chat's run is no agent of this one in `flow`. `flow` takes the thread and recipient its caller already computed. A provider-confirmed `idle` without a turn ends an agent's work unless this chat launched or prompted that run and its turn hasn't begun; reviewers follow `review.ts` `reviewerBusy`, the rule `reviewWorktreeBusy` uses. `restoredSimple` validates reply identities. Build accepts the current worktree’s plan, including in the main checkout. Project drafts transfer into a new worktree through Plan. Story linkage happens before Build; `implementPlannerPlan` and `fixReviewFindings` use `presentation: 'stay'`.

`PlanText.savedMs` mirrors `plans::Plan.saved_ms`, from file mtime. Proposals expose their submission time too. Only artifacts saved after this conversation's latest planner start (or the fresh task's creation time) become a current plan card and enable Build. Earlier plans appear in a collapsed disclosure. `useSimpleData` refreshes disk artifacts on Git changes, proposals, related sessions' starts/exits/turn ends and focus, discarding obsolete requests. `changeGroups` supplies Changes and the shared left diff. Before merging, `merge_conflicts` / `mergeConflicts` runs `merges::conflicts` with `git merge-tree --write-tree --name-only --no-messages`; only paths are reported, never opened. Review uses the role presets and merge destination as its base; Options keeps the existing dialog available. `startSimpleReview` retires only settled previous reviewer generations in the slots the selected presets will reuse, so Review again also works with interactive reviewers that remain at a prompt. A changed generation, active turn or worktree cancels that handoff.

`simpleUi.ts` holds only drafts, structured mentions, one queued message, a chat-only Changes tab flag, diff selection and a transient terminal drawer reason (`closed`, `user`, `input`) per worktree. The composer row holds the recipient's status, **Interrupt** while a turn can be ended, a muted **Terminal** toggle (accessible name View/Hide <role> terminal), **Send anyway** only when the service would accept it, and Send; Stop <role> and Agent settings live in the chat menu. Both controls use `selectRecipient`, following the current step and giving input waits priority. The resizable drawer (`ChatTerminalPanel`) hosts exactly that session's `TerminalPane` in the composer's place: the composer stays mounted but `hidden`, so its draft and errors survive, and the drawer's own × closes it, returning focus to the composer (Escape stays with the program). Its maximize toggle (`terminalMaximized`, not persisted, cleared whenever the drawer closes) hides the thread, step actions and coordination alerts so the terminal fills Chat below its header. The drawer stays put while messages scroll, switches as the recipient changes, and starts closed; opening it through Terminal or View focuses the terminal, while input waits open it without taking focus. Input requests show the hook message and open the drawer; ending a request closes only a drawer opened for input. View of a planner run no chat claims pins it in the drawer (`terminalSession.pinned`) until closed, a new input wait, or its record being forgotten; a drawer whose record is gone reads as closed. There are no stage tabs, per-agent terminal cards or disclosure overrides. The timeline follows new items unless the user has scrolled up. `useSimpleData` computes `changeGroups` and its file references once for the chat-only Changes tab, diff and Chat, and supplies their shared worktree scope; App's `SimpleChanges` chooses the default file, the newest hook-reported write still listed, only in Chat; `SimpleDiff` keeps Map / Stories / Changes visible above the diff. Finding references and the latest hook-reported `Edited …` link select that tab. Full Navigation never shows it.

Prompt delivery uses hook-confirmed readiness and generation checks (`simpleComposer.ts::promptReady` / `deliverPrompt`, `session::prompt_ready`). Enter sends (or starts/queues), Shift+Enter adds a newline, and Enter picks a mention while autocomplete is open. Installed hooks gate new/resumed agents. Sessions whose hooks confirm the turn (`authoritative`: working, asking, or a submission not yet acknowledged) queue by default; an unconfirmed state, such as after Esc, never queues, since no hook may report its end; `simpleQueue.ts::followQueuedPrompts` delivers once at a ready prompt even after switching worktrees. Queued messages append with a blank line, can be canceled back to the draft or sent now, and return to drafts on restart, exit or a failed/uncertain write without retrying. Send anyway (protocol 13 `force`) also accepts a hook-confirmed `working` turn, never `needsInput`, a Codex permission request still in its automatic-review grace (`AgentReport.approval_pending` ↔ `approvalPending`) or an agent without authoritative status, since the pasted Enter would answer a dialog; the service enforces this (`session::prompt_forceable`, mirrored by `simpleComposer.ts` `forceable`) along with the authority and generation checks. Codex either steers a forced message into the running turn, which then stops under the same turn identity, or starts a new turn with it; the forced submission remembers that turn (`previousTurnId`), and its Stop counts as ready only after `FORCED_SETTLE_MS` with no new turn, which `simpleQueue.ts` re-checks on a timer since no later hook arrives. During an input wait the composer offers Answer in terminal, which opens the drawer. **Interrupt** (`simpleComposer.ts` `interruptible` / `interruptSession`, `terminal_interrupt` ↔ `terminalInterrupt`, session protocol 28 `Request::Interrupt`) ends the recipient's turn without stopping its process: under the same authority and generation checks as a prompt, the service writes Esc and, once it is written, `Tracker::on_interrupt` reports a hook-confirmed idle prompt. Hooks of that turn still in flight are ignored, but an approval it asks for afterwards (at once), a tool it starts afterwards, or any report past the settle window, shows Esc only closed provider UI and reopens the turn (`outlived_interrupt`). Claude puts a prompt interrupted before any report back in its input, so the service then clears it with Ctrl+C. A typed Esc still leaves only a guess, so Interrupt is also how a `Not confirmed ready` agent becomes sendable again; agents whose hooks haven't reported in the run are refused. A startup that reports no ready prompt offers Retry connection and Restart agent beside the kept draft, and an unconfirmed delivery settles by itself once the agent's prompt hook names that message in a turn begun after it was written (`deliveryConfirmed`, `unconfirmed.previousTurnId`), never while its send is still in flight; settling it, or Mark sent, also settles the lead notes it carried (`unconfirmed.noteIds`, `settleLeadNotes`). `sendToSession` shares claim/write/release, submission stamps, prompt logging and reply persistence. Drafts, structured mentions and unconfirmed delivery reservations persist in local chat storage without dirtying the map. Queued messages restore as drafts after app restart; an interrupted submission requires explicit delivery resolution before another send. Composer authority is released after writing unless a visible terminal owns it. The shared terminal registry preserves scrollback across drawer, Full and pop-out hosts.

A provider's own question tool (Claude `AskUserQuestion`, Codex `request_user_input` in Plan mode and `request_user_input_async` elsewhere, whose questions carry `title` and plain-string options; all reported as `AskUserQuestion`) carries every question, header and option to `AgentReport.questions` (↔ `types.ts` `UserQuestion`), and `ChatQuestion` shows them. Its `PreToolUse` hook journals the status first, then calls the bridge's `AskUser` (only the agent's own running conversation, once its conversation is reported) and waits up to `agent_hooks::ANSWER_WAIT`; the hook timeout for `PreToolUse` is `QUESTION_HOOK_TIMEOUT`, and an install with the older short timeout reads as not installed. The desktop offers it through `agent_questions::Questions` (`patchbay://agent-question`/`-closed`) only for sessions Chat shows (`agent_questions_watch`, from `ChatMode`); others return at once. A `ChatQuestion` card on screen claims its question (`lib/agentQuestions.ts`) within `CLAIM_WAIT`, else the hook returns nothing and the provider's menu asks in the terminal. Releases wait a tick so a remount keeps them. Send answer gives one answer per question (chosen labels joined, plus Other text); Answer in terminal, leaving Chat, a newer question from the session or the deadline hand it back to the menu. Claude receives the answers as the tool's `updatedInput.answers`; Codex accepts no replacement input, so its call is declined with the answers as the reason. An unanswered asynchronous Codex question stays queued in its terminal while the turn works on. Nothing is typed into the terminal. A call Chat can't show in full (more than `QUESTION_LIMIT` or blank questions) goes straight to the menu.

Tool approvals use the same relay. The reporter journals a `PermissionRequest`, then offers it as `AskUser { permission: true }` with one question (tool as header; command, file, URL or description as text; `agent_hooks::ALLOW` / `DENY` ↔ `agentQuestions.ts` `PERMISSION_ALLOW` / `PERMISSION_DENY`). `ChatQuestion` shows Allow, Deny (with an optional reason) and Answer in terminal; the hook returns the provider's `decision.behavior`, any answer but Allow denying with the user's text as `message`. Once answered it journals `PermissionDecided`, which `status` reads as `working`, since no provider hook ends the wait before the tool finishes. `ExitPlanMode`, question tools and subagents are never offered, and Codex keeps its approvals when `config.toml` names an `approvals_reviewer` other than `user`: in the `profile` the file selects (its `<profile>.config.toml`, then its table), else at the top level, and in any profile table when the file selects none, since the command line may. `PermissionRequest` shares the long hook timeout, so installs with the short one read as not installed. `ChatMode` shows the lead's and running workers' requests (`withOfferedQuestions` adds a held question whose session reports no input wait, as Codex does through its review grace, unless its hooks confirm the turn was interrupted or the agent ended). A denial reaches the hook as `Deny` or `Deny: <reason>`, so no reason reads as approval.

The component mention popup keeps focus in the textarea and exposes its selected option through
combobox/listbox semantics. Up and Down wrap the selection, Escape dismisses the current query,
and changing the query reopens it. Shift+Enter and IME composition retain their input behavior.

`useChatFollow` accepts typed reply markers and owns layout-change detection. On mount, remount,
worktree changes and visible-history or conversation replacement boundaries, Chat follows the
latest content with zero unread replies. Scrolling away preserves the visible message anchor
when older history reconciles or a stage folds. **Jump to latest** counts unseen replies received
since that scope was opened; restored history and duplicate replies add no unread count. Jumping
or scrolling to the bottom clears the count and resumes following, including content resizing.
`chatNavigation::chatReplyId` supplies the same session/generation/sequence identity to reply
markers and rendered message anchors.

Prompt and reply metadata show a local timestamp with the full date in its tooltip and copy the
saved message source. Markdown renders semantic tables and validated HTTP(S) links through the
desktop opener; local, unsafe and malformed links remain text. Code copying preserves the fenced
source bytes, including whitespace and line endings. Unsupported blocks remain plain text, and
copy/open failures show actionable feedback.

Tool activity remains mirrored through `HookEvent.{tool,target,file_target}`, `status::Activity` and `types.ts::Activity`. Explicit file targets alone link to diffs or pulse map components; command previews and patch bodies are never paths. The newest 50 accepted tool events are retained per generation, merged by sequence in `activity.ts`, and scoped to the selected worktree. While its agent works, the latest block names the current step (`activity.ts` `activityLabel`: a verb and the command, file or query, files relative to the agent's folder) with a collapsed list of the turn's retained steps (`turnSteps`); Agents tab cards show each working agent's recent steps. Chat's Auto button keeps the existing Light settings, hook checks and ownership controls; Auto stages drive the flow and gates appear as chat prompts.

`npm run smoke:simple` runs disposable fake agents through prompt, reply, plan, new worktree, Build, Review, Fix, conflict check and Merge while Chat stays open. It also checks drawer following, input waits and saved replies. See [Simple verification](../simple-verification.md) for checks requiring a real interactive desktop and provider.

Plan cards use the saved plan or submitted proposal timestamp. Conversation groups split around intervening plan cards, and equal-time items have deterministic ordering. Later replies never move an earlier plan. Clear hides pre-boundary cards while keeping the underlying plan and Build eligibility.

**Clear chat** confirms inline for its selected worktree and rechecks pending send/workflow actions before clearing. `SimpleState.clearBoundary` retains a timestamp and per-session generation/sequence watermarks. `retainedWorkflow` contains text-free launch, prompt and workflow facts used by ownership, planning boundaries, merge routing and available actions. Restoration, bounded history, rendering, ingestion, reconciliation and draft handoff honor that boundary, so snapshots cannot replay removed text. Drafts, queued prompts, terminals, running agents and provider context, Auto, files and plans are preserved. Provider transcripts and terminal history remain accessible.

A successful merge into `main` automatically clears the source worktree's visible Chat history
using the same boundary. The global merge-cleanup watcher waits for confirmed Git integration
and a finished merge turn, including completed Auto runs. A persisted `chatCleared` marker keeps
polling and restart recovery from clearing later messages. Other projects and worktrees are
unaffected. Terminal sessions, provider conversations, drafts and the checkout remain intact.
The existing **Merge complete** confirmation still controls branch/worktree deletion and
returning the original checkout to the destination branch. Chat clears whether the merged
branch/worktree is kept or deleted. Merges into other destination branches leave Chat history intact.

Deleting the work ends its chat. After **Delete worktree and branch**, **Return to `main` and delete
feature branch**, or the worktree picker's **Remove worktree** and **Forget only** succeed,
`chat::retire_task` removes the team with its checkpoint, saved context, messages and worktree lease,
and stops its unfinished rounds. The desktop closes and forgets the team's agent terminals, including
isolated workers, whose worktrees stay because they can hold unintegrated commits. `forgetTeamChat`
resets the worktree's Chat log, workflow facts, draft and queued message. No replacement lead starts;
the next message launches one. A cleanup that fails with the worktree still in place changes none of
this, so it can be retried. Returning to `main` closes only the chat's stage agents; shared planners
and Map agents in that folder stay.

Chat's Merge button checks the source first. With uncommitted changes it opens the shared merge dialog on the chosen destination, which asks whether the merge agent should commit them; see [Worktrees](worktrees.md). A merge that ends with a dirty worktree offers **Merge again** through the same path.

Every stage already launches a fresh conversation, so finishing work retires agents rather than
clearing them. A finished turn alone proves nothing, because an agent may have stopped to ask a
question. Launching the next stage is the confirmation: after a review, fix or merge launch from
Chat or its dialogs, `stageRetire.ts` stops earlier build, fix and review agents this chat launched.
It keeps any agent that is not in an authoritative `review` state, has a pending approval or queued
prompt, was prompted since that state, belongs to another chat, or is the lead, and does nothing
while Auto owns the worktree.
Stopped agents keep their conversations, so messaging one resumes it.

The task itself finishes on a confirmed merge into `main` whose worktree is kept, or when
an Auto run in place reaches `done`. A merge agent's finish is a passive notice, so it does not give
the lead a turn that would count as moving on. The cleanup choice is final immediately: `contextPending` on
the job, or `taskDoneAtMs` on the run, keeps retrying `completeTeamTask` across restarts. Its
`completeTask` control carries a stable `task-done-<id>`, recorded in `Team.finished.tasks`, so each
completion is decided once. A lead that is busy, has had a turn since the merge or run finished, or
has active rounds or open requests keeps its conversation. Otherwise the completion queues a fresh
conversation or joins one already pending; without a lead session it clears the task at once.
Stopped teams stay stopped; paused teams keep the reset queued until **Continue work**. Once the
replacement is confirmed, the checkpoint's goal, decisions, remaining work and validation, the saved
context, plan copy and retained briefing are cleared. Waiting lead messages from finished work are
settled, and `Team.finished` keeps settled rounds and requests out of recovery text while durable
records retain them. A failed replacement changes nothing.

The composer subscribes to provider usage and the shared clock. It shows every unexpired window at or above 100% for its recipient’s provider, falling back to the selected worktree planner before launch. Each warning names the provider, window, reset time and countdown. Warnings expire at reset and do not depend on notification preferences or Auto thresholds, and do not disable Send or terminal access. Missing data stays unknown.

### Usage limits

`AgentReport.limitStoppedMs` records a turn ended by a usage limit: Codex's `task_complete` with
`usage_limit_exceeded` (read by `agent_context::CodexReader`, accepted only at or after the current
turn's prompt) or Claude's `StopFailure` with `rate_limit` or `billing_error`. The next turn clears
it. The agent reads Idle, and lead replacement stays allowed. Coordination is held
(`chat::limit_held`) for 15 minutes and for as long as the subscription has a spent window, then
retries, so a brief rate limit does not stall a team. Held messages never hold the user's prompt, which
can start the next turn at any time. A queued prompt waits for **Send now** or Send. `ChatLimitNotice`
names the reset and offers **Continue with** each other preset. It and **Retry with…** disable presets
whose own subscription is exhausted. Nothing switches automatically. A limited worker fails with that
reason, and **Retry with…** reruns its assignment on another agent while keeping the lead's requested
`preset` for idempotent delegation.

### Persistent lead and coordinated workers

`reviewAgents::chatReviewBase` supplies Chat's review launches and changes reader with the same
base. A valid saved review choice takes precedence; otherwise the default merge destination
branch is used even without a checkout, followed by the available task/review defaults. Destination
checkout metadata is needed separately for conflict checks and direct merges, never for choosing
the review base. Finding selections made during a comparison reload resolve through
`changeNav::resolveChangeSelection` when files arrive, preserving explicit component choices and
the requested line.

Chat root launches retain `SessionSpec.purpose = chat` (`ordinary` is the legacy default).
`context::chat_session_spec` supplies a dedicated persistent-lead briefing: saved plans,
assignments and conversation context are reference material until the user asks for work.
Ordinary implementation/planning launches keep their existing handoff behavior. Restarts,
resumes and conversation resets retain the launch purpose.

The briefing ends with `## Lead role` (`chat::LEAD_ROLE_HEADING`): `chat::lead_instructions`, the
same structured coordination instructions every handoff repeats. The lead coordinates agents and
talks to the user; agents do every task (`startPlan`, `startBuild`, `startReview`, `startFix`,
`startMerge`, report and code workers, `startAuto` for a whole pipeline). It never edits project
files, and when delegation is impossible or an integration conflicts it explains the blocker to the
user rather than doing the work. This is an instruction, not an enforced restriction. A new lead launched with that section, without an
earlier goal and not adopted paused, starts with `recovery: false`, so the user's first message is
its first turn; adopted conversations, older briefings and every restart, resume, compaction or
replacement still receive the handoff. The team's retained `originalBriefing` ends before the role.

Session protocol 24 bootstraps each Codex chat process with one internal CLI prompt requesting
only “Ready”, without tools, edits, commits or delegation. The stored launch and resume commands
exclude that prompt; the PTY appends it once per process, including resumed and reset conversations.
Claude chat leads need no bootstrap. Codex starts with generation-bound `chatStartup: pending`;
only an accepted successful Codex `Stop` with a current turn identity changes it to `ready`.
Stale hooks, status files, interrupts and process exit cannot establish readiness. The bootstrap
reply stays in the terminal and is suppressed from Chat reply history. Snapshots and started/status
events carry readiness to the UI. Composer readiness, forced sends, coordinator delivery and the
session service's final prompt gate all wait for startup to finish. The 30-second composer timeout
reports that readiness could not be confirmed and leaves the user's message unsent.

Protocol 25 promotes retained legacy leads to the Chat launch purpose when Chat resumes them
or reconstructs a conversation after missing history. Both paths run the same startup exchange;
ordinary session resumes keep their original purpose. A running legacy lead without readiness
must be stopped once, then reconnected by sending again. Its saved history remains available.

Chat identities use durable team membership: Lead for the team's lead, Builder for its workers
and adopted scopes, otherwise Agent. Headers, the drawer and the composer show `chatIdentity`'s
`title` (role · provider · preset), omitting a preset named after its provider. Opening a
Builder terminal changes the drawer identity while the composer continues to address its recipient.
Build view terminal tiles use the same Lead and Builder roles for team members.

Each worktree can have one persistent chat team. The saved `selectedAgent` becomes its lead when
coordination is initialized; existing conversations migrate paused, preserving their history and
recipient without launching workers. **Switch agent** queues an explicit durable provider-conversation
replacement that stops the current lead at once, even mid-turn (after an inline confirmation) or
while work is paused; a queued prompt for that lead returns as a draft. **Clear lead context** confirms inline that provider context resets and visible
history is replaced with a concise handoff. It uses the same durable replacement while retaining
workers, assignments, results, inbox messages and checkpoints. Unless rounds or requests are active,
the replacement's handoff is passive (`Team.quiet_recovery`): it travels with the user's next message
and starts no turn. The confirmation belongs to one
visit to a worktree and disappears after switching away; pending send/workflow actions and an
existing reset disable confirmation. Failed replacement preserves history.
**Clear chat** only advances the existing reply
and plan-card boundaries; it leaves provider context and team state untouched.

`orchestration::chat` stores teams alongside provider runs in the private task store, independently
of `SimpleState`. A team owns a worktree, logical lead, session generation and observed provider
conversation, checkpoint, worker presets, limit, rounds, message sequence and reset journal.
Chat-owned implementation rounds attach that lead as their coordinator; they never launch a second
coordinator. Workers use the existing task worktree preparation and integration journal. Assignments
explicitly choose `resultKind: report | code`. A report completes through `team-report`; code needs
a clean committed HEAD submitted with `team-result`, serial integration and a fresh checkpoint
before `team-finish`. A process exit or final reply alone is never success. Report worktrees inspect
the recorded committed baseline even when the target contains local changes. Code delegation
refuses dirty targets without committing or stashing user changes. Dependencies wait for submitted
reports or integrated code, and launch reservations enforce the team-wide worker limit (default two,
excluding the lead).

The authenticated `agent team*` CLI derives membership from persisted session and task identities,
including isolated worker tasks. Session protocol 21 returns the authenticated process generation;
reused command capabilities rotate on resume so a superseded process cannot act through a new
incarnation in the same session slot. The current lead generation owns delegation, checkpointing,
integration and finishing. Workers can submit only their assignment and message only their lead.
The lead routes dependencies between workers. The desktop's typed team commands expose pause,
resume, stop, retry, worker settings, new-lead selection, side messages and explicit delivery recovery.
Auto, chat and manual provider runs share exclusive target ownership; stopping a team releases its
target without deleting results or worktrees.
The Agents tab shows the team's work status. Pause and stop use the Chat menu; retry uses the failed assignment's inline action. Manual plan handoffs cannot
adopt chat-owned coordinators.
A Build, Review, Fix or Merge the user starts from Chat's step card is told to the lead once
(`chatTeams.ts` `noteLead` → `Control::Note`, a `patchbay` inbox message keyed by the launch's
request), so the lead neither repeats that work nor ignores its result. The note and the finish
notice of the sessions it names (`Team.noted_agents`) are `passive` messages: `deliver` never starts
a lead turn for them, since the step card already reports that work, and sends them with the lead's
next coordination batch, or after the user's own words in their next prompt to the lead
(`sendToSession` appends `leadNotes` and settles them with `Control::NotesDelivered`).
`leadDeliveryPending` ignores them so they never hold the user's prompt. Noted work that exits, or stops a turn after the note (`noted_since`), before any reconcile pass saw it working is settled passively too, so the session's later work wakes the lead again.

`watchProviderRuns` continues to refresh and drive all open projects while Chat is unmounted or a
different worktree is selected. Core reserves each delivery before transport and batches pending
messages in sequence at a hook-confirmed ready prompt. It checks session generation, approval state,
authority and the last delivered ready turn. It never forces an automated message. A lost submission
reply stays uncertain until explicitly marked delivered or retried. Explicit results, failures and native input
waits notify the lead. Worker conversations remain available through Sessions; Chat shows one lead
conversation. Failed and input-waiting workers, coordination errors and unconfirmed deliveries raise
alert lines above the composer with their recovery actions (Retry work and Agent settings, View worker
terminal, Mark delivered or Retry delivery).

**Agents** sits beside Map / Stories / Changes, in Chat only (`AgentCanvas`, its own React Flow store, so
the map's viewport is untouched). `chatAgents.ts` `chatAgentCards` lists the team's undismissed
assignments and every other running agent of this chat, `agentSnippet` picks each card's line (input
wait, failure, recent steps, summary, instructions, last reply) and `agentLayout` places the lead,
workers, other agents and finished work in rows, wrapped at the column count `agentColumns` finds
shows cards largest in the canvas. Cards subscribe to their own sessions; the graph rebuilds only
when membership or job state changes and refits when the layout or canvas size does. The minimap and
its toggle are `CanvasMinimap`, sharing the Map's saved preference. Cards and minimap nodes use the
role colors of Chat's agent headers. The tab's label
counts unfinished agents and flagged items, with the breakdown in its accessible name. Terminal
opens the session in Chat's drawer, expanding a hidden chat. Selecting a card opens details: steps or
the last reply, and for assignments the instructions, summary, report, retry and settings actions.
Under the tabs, the team's status line offers Open Sessions. Dismissing a failed or completed
assignment, from its card or details, hides its current result from the canvas, count and alerts, offers Undo (which takes
focus), and lists it under Dismissed with Restore. The worktree's chat UI persists dismissals locally,
pruned to the team's current results. Retried work appears again, and coordination retains its results.
Chat-owned rounds appear here only;
other provider runs remain in Plan or Build. **View worker terminal** opens the exact project session
without changing the composer recipient. Messages and queued prompts take their recipient's workflow
stage, so messaging a build agent after a merge resumes the build flow. A team's lead has no stage:
`thread` leaves its session and prompts out of stage selection (`SimpleSnapshot.lead`), unless that
run was launched for a stage and then adopted as lead. The lead sets the status itself instead.
Continue work resumes previously launched rounds and rounds paused by restart. Unlaunched queued
rounds otherwise stay paused and are included in the lead's recovery handoff.
Worker presets and concurrency
settings live in Settings → Agent roles. Pause work, Continue work and Stop work live in the chat menu.
Lead messaging and its inbox remain available while worker scheduling is paused or stopped.

The lead requests progress, findings, blockers and dependencies from existing agents with
`agent team-ask --id <request-id> --to <assignment-or-session-id> --text <question>`.
`team.informationRequests` tracks questions and responses durably. Busy recipients receive questions
at their next ready prompt and answer with `agent team-reply --id <request-id> --text <response>`.
Requests and replies deduplicate by ID and authenticate the recipient’s membership and generation.
Exited or superseded recipients produce a durable failure notice without launching a replacement worker.
The lead synthesizes reported results and validation for the user and follows up on outstanding requests.

Provider-native compaction remains in control of context size. An observed compaction, provider
conversation change or lead generation change schedules one recovery update at a ready prompt. It
contains the current checkpoint and structured assignment/integration state, followed by unread
messages; delivered messages and full transcripts are never replayed. New lead presets receive
these instructions in their briefing too. Recovery updates exceeding the inbox message limit use
an abbreviated checkpoint and recent round counts, with an instruction to inspect `agent team`
before continuing; complete checkpoint text, assignments and results remain in durable storage.

Conversation replacement persists its request identity and launch template before stopping a ready
superseded lead or starting the replacement. A busy lead queues the reset; new launches and lead
delivery wait while running workers may still submit results. Reconciliation rebinds membership to
the replacement generation before delivery resumes. The visible transcript clears only after a
confirmed replacement, and retains a concise handoff with an idempotent application marker. Failed
or interrupted replacement preserves history and retries the same request identity after explicit
Resume. Unfinished coordination restores paused after app restart, including uncertain deliveries;
Stop clears the restart notice (`RESTART_NOTICE`) from the team and its rounds; other errors, such as Block reasons, remain. The status line shows the notice in place of `Paused` rather than as a separate alert.
Session protocol 23 retains protocol 22’s generation-bound resets for existing leads by session ID and generation inside the service, retaining
their private environment, original launch options and recoverable briefing without exposing those
settings in session summaries. Retried reset identities launch only once, and stale generations
cannot replace a newer process. A paused team can resume a queued replacement even if its old lead
session has been removed, provided the replacement has a saved launch template or retained session.

`npm run check` covers team handoffs, history boundaries, background worktree routing and existing
chat behavior. `node scripts/smoke-all.mjs chat-team chat-controls` exercises real session transport
with disposable fake providers, authenticated report/code results, existing-agent information requests,
chat-menu controls, both clear actions, exact resume, forgotten sessions and missing provider history.
The chat-team harness quits and relaunches the desktop to verify preserved drafts, history, responses,
stop decisions and reconnection without a duplicate lead. Core regression tests also cover ownership, dependencies, worker
limits, stale generations, duplicate commands, compaction and reset races.

`chat_continue` resolves a worktree’s durable lead through core `continue_lead`, returning the session,
generation and `connected | resumed | reconstructed` outcome. Send connects to live work, resumes
its exact provider ID, or automatically reconstructs only a confirmed unavailable conversation ID or
provider history. Authentication, access and configuration failures are structured and actionable;
transport uncertainty retains the durable launch identity. Recovery uses the same saved agent preset,
retained original briefing, current plan, checkpoint, assignments/results, workflow requests, outstanding
information requests and bounded recent saved messages. Visible-history boundaries exclude cleared
messages from that context. Reconstruction reuses the replacement journal with history clearing disabled
and adds a small notice. Team membership reconciles before delivery; pending user messages wait for
recovery/inbox delivery and a later ready prompt. Service-level submission reservations serialize pastes
and prevent two clients from consuming the same ready prompt. Explicit pause/stop decisions survive
recovery. Intentional agent switching and conversation clearing remain separate actions.

### Lead status

`agent team-status --step <step> [--note <text>]` (`Command::Status` ↔ `Team.status`, steps mirroring
`SimpleStep`) records where the lead says the work stands. `simpleFlow.ts` `chatStatus` shows it in
the status strip unless Auto is running or a stage was launched after it was set; a team without a
status uses the step `flow` derives. When the lead's step differs from the derived one, Chat hides the
derived step card. A completed task's replacement lead starts at `idle`.

### Lead-started stages

The lead uses the same stage artifacts as Chat's step card and Full view, so either surface can
continue the work. Chat leads launch with `PATCHBAY_PLAN_FILE` so they can read their worktree's
plan. `startPlan` (`{ goal, components? }`) launches the plan role's planner with
`Kickoff::PlanRequest` and the goal in a `Plan request` briefing section, refuses a planner slot
already running, and completes only if a plan was saved after it started. `startMerge`
(`{ destination?, commitSource? }`) runs `startBranchMerge` from the team's worktree with the merge
role, to the named or default destination. Uncommitted changes fail the request with their list until
the lead retries with the entries the user approved. A confirmed merge settles passively, and task
completion settles a merge still marked running, so neither counts as lead work. Any other outcome
wakes the lead. Chat also shows questions from the agents of running lead stages.
`startBuild` and `startFix` (`leadStages.ts`)
call `implementPlannerPlan` and `fixReviewFindings` for the team's worktree, which may not be the
one on screen. They and Chat's Build and Fix buttons pass the team id, which admits the launch past
the team's own worktree ownership and starts one agent rather than a provider run. Their requests
stay `running` until the agent ends a turn or exits, and that result wakes the lead. `startFix` also
refuses while any reviewer of the worktree may still be writing. `startReview` (`{ base?, focus? }`)
runs through `council.ts` with the review role's presets and Chat's review base: the branch's last
review base, else its merge destination. It needs provider sign-in but not status hooks, like Chat's
Review. One reviewer has no lane; several get one each, as `startReviewAgents` does. Findings go to
the regular review files, each launch is logged with `logStageLaunch`, and the reviewer's finish is
a passive note because the workflow result carries the verdict and an excerpt to the lead. A
reviewer that ends its turn without findings for the round, exits, or disappears fails its member,
and Settings can cancel the review. Only one plan, build, fix, review, council or merge can be active per team.
`report` workers remain for investigation. These stages don't retire earlier stage agents, unlike
Chat's buttons.

### Lead review councils

Agent roles settings persist `settings.reviewCouncil` independently of Review assignments:
`{ enabled, members: presetIds[], concurrency }` (off by default, concurrency 2, range 1–8).
An enabled council needs at least two available distinct presets. Each preset retains its own
provider, model and authentication. The settings explain the additional model usage.

Catalog synchronization exposes effective council settings to the persistent lead; missing
presets disable new councils without blocking other team workflows. The lead requests
`startCouncilReview` with `{ base: branchName, focus?: reviewFocus }`. Core validates opt-in, deduplicates request IDs,
rejects overlapping council requests and snapshots the selected presets and settings in the
durable workflow request. Desktop drives the existing review sessions with one shared round
and a lane per preset, limiting simultaneous reviewers. It saves launch intent and request IDs
before launching, reconciles lost replies, and never relaunches uncertain members on restart.
Queued members interrupted by restart become explicit failures requiring a fresh council.

`WorkflowRequest.councilRun` retains member progress after the final `result` becomes the
lead-facing report. Completion is delivered through the existing durable team inbox. The lead
consolidates duplicates with attribution and explains disagreements. Missing verdicts, failed
members, newer review rounds, changed HEAD/worktree contents, uncovered files and truncated
reports prevent a complete council result. Council results authorize neither fixes nor merges.
Settings show progress and allow cancellation or an explicit fresh full council after failure;
individual reports remain available in Review. Settled reports and their HEAD/coverage sidecars are also archived under the originating request before lanes are reused; the final inbox result points to that archive. Council scheduling runs while desktop team
reconciliation runs, like other lead workflow requests.

Chat workflow suggestions persist dismissal per project/worktree, conversation boundary, workflow
attempt and prompt type (retaining every dismissed identity) in `patchbay.chat-drafts`. Artifact loading and transient agent activity do not
clear it; new attempts and completed merge confirmations have distinct identities. Merge prompts
wait for the initial artifact read and offer conflict recovery only for a confirmed `notMerged`
outcome. Unknown outcomes, changed branches and missing historical worktrees show status
unavailable with **Retry status**, which refreshes the scoped artifact reader. They never imply
integration or an unfinished merge from a missing outcome alone.
Legacy merge sessions without a saved request retain paths but cannot establish the original
branch pair; their status stays unavailable instead of substituting current checkout branches.

Chat's Changes pane shares Review's sticky worktree context header, refresh/retry feedback,
aggregate line totals, and component cards. Cards show kind colors, file counts, line totals,
and active-task validation chips (except for project files). Component names remain labels.
Review and Chat render component cards through the shared `ChangeGroupCard`.
Groups start expanded; collapsing one preserves the open diff. File stepping and navigation
counts include only expanded groups; selection resolution and aggregate totals retain all files. Local collapse and commit-history
selection reset when the conversation worktree changes. Map / Stories / Changes tabs, finding
line links, file stepping, and commit history retain their existing chat behavior.
