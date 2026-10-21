# Agent status integration

Open **Tools → Agent status integration…**, select Claude Code or Codex, and inspect the
**User hook source**. **Install status hooks** is opt-in. **Check integration** separates
configuration installation from reporting confirmed in a running Patchbay session.
**Remove status hooks** removes only the exact entries this installation owns.

Claude defaults to `CLAUDE_CONFIG_DIR/settings.json`, or `~/.claude/settings.json` when the
variable is absent. Codex uses `CODEX_HOME`, or `~/.codex`: existing inline hooks in
`config.toml` remain the source; otherwise installation appends to `hooks.json`. Both TOML
array tables and inline arrays are supported. If the login shell defines a different
provider directory than the desktop inherited, select the corresponding absolute user
source in the setup dialog.

Codex requires review and trust of the current hook definitions through `/hooks`. Patchbay
never adds a trust bypass or changes approvals. Hook-disabled settings, profiles, managed
policy, project settings, existing `--settings`, and `--setting-sources` remain under the
provider's control. Inspection detects Claude's user `disableAllHooks` and Codex's user
`features.hooks`/deprecated `features.codex_hooks`; it cannot establish effective runtime
trust or every higher-precedence policy. Reporting remains unconfirmed until a native hook
arrives from a running process.

Supported parent-turn events map to these states:

| Events | State |
| --- | --- |
| UserPromptSubmit, PreToolUse, PostToolUse, Claude PostToolUseFailure | Working |
| Codex PermissionRequest | Working until 3s without terminal text updates, then Needs input |
| Claude PermissionRequest, Claude permission notification | Needs input immediately |
| Stop | Ready for review |
| SessionStart, Codex Interrupt, Claude StopFailure | Idle |
| SessionEnd | Ended |

Compaction SessionStart preserves an active turn. Native Working survives quiet terminal
output. Codex permission requests may be answered by an automatic reviewer, so they retain an
authoritative Working state, preserving when work began, until the terminal text stays quiet
for 3s; the confirmed prompt asks from that moment, so a window seen during the grace doesn't
acknowledge it. Claude sends PermissionRequest only for a dialog it shows. Text activity keeps the request pending for as long as an automatic review or
approved command continues updating the terminal. Cursor controls and window-title updates
do not extend the quiet window, nor does the echo of keys typed into the dialog. Each new permission request gets its own quiet window, even when the previous
tool emitted no progress hook. Duplicate journal deliveries are rejected by sequence number.
Typing during a pending request clears it and keeps Working and its start time, but
unconfirmed, since it may deny the request without a hook. Answering a confirmed Needs input prompt makes Working unconfirmed until the next
provider hook. Esc turns a pending or confirmed prompt into unconfirmed Idle and other
Working into unconfirmed Working that goes idle after 15s of quiet. Mouse and focus reports
do not suppress output as input echo. PTY exit clears pending approvals and ends unresolved
native work before publishing Exited, so later snapshots and seen updates cannot confirm a
prompt; hook events drained just before the exit still apply (a final Stop reads as review).
An explicit Ctrl+C records interruption, and subsequent provider events resume
authoritative reporting. A `resume` or `clear` SessionStart switches to that conversation, even
one seen before; a `startup` SessionStart in another conversation comes from a nested run
(`claude -p`, `codex exec`) inheriting the terminal's environment and is ignored.
Without provider reports the existing Active/Quiet output fallback remains. Providers must
supply Codex `turn_id` or Claude `prompt_id` for turn events; an uncorrelated prompt restores Active/Quiet, and uncorrelated tool events are ignored.
Subagent identifiers and SubagentStop never complete the parent turn. Claude's main
`--agent` selection remains supported because `agent_type` alone is not a subagent identity.

Installation copies the packaged `patchbay-sessiond` executable to a stable, machine-local
`~/.patchbay/reporters/patchbay-status-v1` path (`.exe` on Windows). It installs no shell
scripts or language-runtime dependencies. Claude executes the binary and argument array
directly. Codex uses a safely quoted native command on Unix and an encoded PowerShell
command on Windows. Reporter commands exit successfully without stdout, stderr, provider
decisions, or changes outside a Patchbay reporting environment.

The PTY service supplies a private journal, opaque session ID, process generation, and
provider identity. Launch settings cannot redirect these transport fields. Individual,
atomically committed report files prevent rapid prompt/completion writes from overwriting
each other. The tracker rejects other process generations, retired conversations/turns,
reordered sequence numbers, duplicate prompts, and progress after completion. Confirmed provider conversation
IDs update continuity records without replacing a user-pinned ID. Retained history keeps
its launch directory and accepts old status records without native-hook fields.

Setup preserves unrelated user configuration and handlers, writes atomically, checks for
concurrent changes, and refuses malformed JSON/TOML and symlink/non-file replacement.
Unrelated TOML text and comments are retained; affected hook event tables may be reformatted.
Ownership requires the exact provider command, arguments, type, and Patchbay marker. Edited
or similarly named user entries are preserved. Repeated installation/removal is idempotent.
The native configuration broker is available only to the main application window.

## Validation recorded on October 6, 2026

Read-only provider inventory found Claude Code 2.1.290 and codex-cli 0.160.0; Codex reports
its canonical `hooks` feature as stable and enabled. No real provider hooks or conversations
were changed for these inventory checks.

On macOS arm64:

- Rust formatting, workspace Clippy with warnings denied, frontend checks/build.
- Native workspace tests, including 197 core regressions, 3 CLI tests, existing 2 helper
  lifecycle tests, and 3 new packaged reporter process tests.
- New regressions cover existing JSON/TOML hooks, inline TOML, disabled features, exact
  ownership, argument punctuation, malformed sources, atomic replacement permissions,
  quiet Working, generation/turn/conversation guards, main custom agents, subagents,
  interruption, older-provider fallback, concurrent reporters, and legacy history compatibility.
- `npm run smoke:status` uses isolated provider sources and local state. It exercises native
  repeated installation/removal, a real packaged reporter in an interactive fixture PTY,
  permission/progress/completion/end events, quiet Working beyond the previous timeout,
  subagent/late-progress rejection, and the actual setup dialog. The harness checks that
  unrelated Claude settings and Codex configuration survived.

Sandboxed macOS watcher tests can time out; native workspace tests require real FSEvents
and loopback socket access. The native suite passed with those permissions.

## Release gates still open

The fixture reporter validates Patchbay's transport and UI, not provider trust behavior.
Real interactive Claude and Codex sessions still need prompt, approval, completion,
interruption, compaction, exact resumed conversations, disabled/trust settings, custom
launch settings, and subagent validation. Do not infer release readiness from synthetic
provider payloads. Windows/Linux native tests and packaged reporter execution remain
outstanding. On Windows specifically, validate Claude exec-form hooks and Codex's encoded
PowerShell launcher with spaces/punctuation in the installation path and existing settings.
Installed reporter copies should be reinstalled after updates that change the reporter.

## Approval activity capture on October 20, 2026

Codex CLI 0.162.1 was run under `script -q` in a scratch repository with
`approvals_reviewer=user` and `approvals_reviewer=auto_review`, requesting escalation for
`sleep 20 && echo done`. The user approval dialog remained open for more than 10s. Its text
was static, but it continued emitting CSI redraw controls and an OSC window title alternating
`[ ! ] Action Required` and `[ . ] Action Required`. Raw-byte silence cannot identify this
prompt. During automatic review and the approved command, the on-screen spinner and elapsed
seconds continued updating. The tracker therefore measures approval quiet from non-echo text
bytes outside terminal controls, retaining partial escape sequences across output chunks.

Contracts were checked against the [official OpenAI hooks documentation](https://learn.chatgpt.com/docs/hooks?site_variant=chatgpt&translationFallback=zh-Hans)
and [Claude hooks reference](https://code.claude.com/docs/en/hooks). Claude user-directory
behavior follows its [settings documentation](https://code.claude.com/docs/en/settings).
