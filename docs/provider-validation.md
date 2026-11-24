# Antigravity CLI and Muse Code validation

Phase 0 is in progress. The captures were made on macOS Apple Silicon with
Antigravity CLI 1.5.15 and Muse Code 1.4.25 (1.4.25-R9361.1).

## Reproduce the hook captures

Use the captured versions of the CLI binaries. Check them with `agy --version`
and `MUSE_NO_AUTO_UPDATE=1 muse --version`. These are the release artifacts for
the original macOS Apple Silicon setup.
[Antigravity 1.5.15 archive](https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/darwin-arm/cli_mac_arm64.tar.gz),
[Muse 1.4.25-R9361.1 release manifest](https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.25-R9361.1&file=manifest.json)

From the repository root, run the capture helper with Python 3.8 or later.
Replace the binary paths below with the installed binaries. Each probe writes a
`hooks.jsonl` file with one hook input per line in a fresh output directory.

```sh
capture_dir=$(mktemp -d)
python3 docs/provider-validation-capture.py antigravity-read /path/to/agy "$capture_dir/read"
python3 docs/provider-validation-capture.py antigravity-question /path/to/agy "$capture_dir/question"
python3 docs/provider-validation-capture.py muse /path/to/muse "$capture_dir/muse"
```

- **Antigravity** uses a disposable home and workspace. The helper creates
  `validation.txt` and writes the named hook group in `.agents/hooks.json`.
  Lifecycle and invocation events use direct handlers. Tool events use a
  `.*` matcher group. The helper starts a Gemini stub bound to `127.0.0.1`,
  sets `GOOGLE_GEMINI_BASE_URL` and a placeholder `GEMINI_API_KEY`, and runs
  `agy --settings '{"modelProvider":"gemini"}' -p <prompt>`. The stub streams
  one tool call followed by a text response after the tool result. The question
  probe asks the user to pick a color and records the `ask_question` call
  before denying it with a sample answer.
- **Muse** uses a disposable home and `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and
  `XDG_CACHE_HOME` directories. The helper writes
  `$XDG_CONFIG_HOME/muse/settings.json` with `schema_version: 1` and a command
  hook group for each of the eight captured events. It runs
  `muse exec --provider echo 'Reply with PATCHBAY_VALIDATION'`. That run also
  starts the built-in reminder observer, which supplies the subagent hooks.

Select the payloads by event name. For the Muse LLM fixtures, use the
`PreLLMCall` and `PostLLMCall` records from the root session with the same
`request_id`. Use a `SubagentStart` and `SubagentStop` with matching
`child_session_id` values from the same run. Replace local paths and generated
identifiers consistently across the files. The committed LLM fixtures omit
`messages`, `tools`, and `options` while retaining counts and result metadata.
The subagent stop fixture redacts the echoed observer prompt.

Run `cargo test -p patchbay-core agent_hooks::tests::` to check the committed
fixtures. The tests check the hook fields, the Antigravity question arguments,
and the distinction between Muse root and child session IDs.

## Antigravity CLI

- The binary accepts `--conversation <uuid>`, `-i <prompt>`, `--add-dir <path>`,
  and `--mode plan`. Its `--settings` flag accepts an ephemeral JSON override.
  [CLI reference](https://antigravity.google/docs/cli/reference/)
- The documented user hook path is `~/.gemini/config/hooks.json`. The installed
  binary loaded the same named-group schema from `.agents/hooks.json`. Tool
  events used a matcher group and lifecycle events used direct handlers. The
  invocation events are `PreInvocation` and `PostInvocation`. `PreInvocation`
  fired for each model call, including the call after a tool result. A reporter
  must account for multiple invocations in one user turn.
  [Hook configuration and events](https://antigravity.google/docs/hooks)
- A print-mode run against a loopback Gemini stub emitted `SessionStart`,
  `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, and `Stop`.
  `Stop` included `executionNum`, `continuationActive`, and `fullyIdle`.
  The successful stop reason was `NO_TOOL_CALL`. Hook payloads pointed to
  `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`, and the file
  existed. Use the reported path when available and account for the documented
  `transcript.jsonl` spelling when looking up older sessions.
  [Hook payloads](https://antigravity.google/docs/hooks#input-and-output-contract)
- The installed build called `read_file` with `Path`. The hook docs also describe
  `view_file` with `AbsolutePath`. `ask_question` took `questions` with string
  `options` and boolean `is_multi_select`. A `deny` result with `reason` returned
  the answer text to the calling model in the tool error. `allow` plus an
  `overwrite.answers` object changed the arguments but produced `User Skipped`
  in print mode. This supports using the denial reason for question relay.
  [PreToolUse output](https://antigravity.google/docs/hooks#pretooluse)
- The documented question-independent permission decisions include `allow`,
  which delegates to the normal policy, and `auto_approve`, which still honors
  explicit rules. Native approval relay still needs an interactive capture.
  Session briefing uses the documented nested `injectSteps` form
  `[{"systemMessage":{"systemMessage":"…"}}]`.
  [Hook decisions and injection](https://antigravity.google/docs/hooks)
- A signed-out `-p` run offered a browser URL and authorization-code entry, then
  exited with an authentication timeout. It starts an auth flow and is unsuitable
  as a passive status probe. The tested app-data and config environment variable
  candidates did not redirect startup away from `~/.gemini/antigravity-cli`.
  [Authentication](https://antigravity.google/docs/install?tab=cli)

## Muse Code

- The binary accepts `muse <prompt>`, `muse resume <uuid>`, `muse login`, and
  `muse usage --json`. In a clean config with `META_API_KEY` unset, the usage
  probe exited with status 1 and told the user to run `muse login`. Authenticated
  output and API-key-only behavior still need validation.
  [Authentication](https://dev.meta.ai/docs/muse-code/auth)
- `settings.json` with `schema_version: 1` accepted a `hooks` object containing
  event-name keys, matcher groups, and command handlers in the disposable
  `$XDG_CONFIG_HOME/muse` directory. In echo mode the runtime emitted
  `SessionStart`, `UserPromptSubmit`, `PreLLMCall`, `PostLLMCall`, `Stop`,
  `SubagentStart`, `SubagentStop`, and `SessionEnd`. The root session and turn IDs
  are snake_case. In this capture, both subagent events reported the child ID in
  `session_id` and `child_session_id`, and it differed from the root ID.
  [Configuration](https://dev.meta.ai/docs/muse-code/configuration)
  [Hook lifecycle](https://dev.meta.ai/docs/muse-code/extending#hooks)
- The echo run retained `session.jsonl` in
  `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<uuid>/` even though its hook payloads
  carried `transcript_path: null`. The bundled `read-session` skill confirms
  `~/.local/share` as the default data root when `XDG_DATA_HOME` is unset.
- In the echo probe, Muse did not forward `PATCHBAY_REPORT_SESSION`,
  `PATCHBAY_REPORT_GENERATION`, `PATCHBAY_REPORT_DIR`, `PATCHBAY_REPORT_PROVIDER`,
  or `PATCHBAY_CONTEXT_FILE` from the parent process to the hook command. Native
  reporting needs a verified way to carry per-launch identity to the hook.
  `-c 'hooks.SessionStart=[]'` suppressed the user-configured `SessionStart`
  handler for one run, which confirms that per-run overrides can replace event
  definitions. Any use of them must preserve the user's other hooks. The CLI
  rejected `extensions.hooks.allowed_env_vars` as a per-run `-c` setting.
- The echo probe found no marker in the first model request after a
  `SessionStart` handler returned `additionalContext`, including a probe with
  the nested Claude-compatible `hookSpecificOutput` shape. Use the documented
  positional prompt for briefing until startup hook injection is demonstrated.
  [Muse Code changelog](https://dev.meta.ai/docs/muse-code/changelog)

## Remaining account checks

Both providers still need an authenticated interactive session with a prompt,
question, permission decision, planning, interrupt, exit, and exact-ID resume.
Capture the exit hint, authenticated usage or sign-in output, and any limit errors.
Verify Antigravity's plan artifact and Muse's tool names, permission output, and
reporter identity mechanism before relying on them in Patchbay. Treat quota
telemetry as unknown where the authenticated CLI cannot expose it reliably.

The fixtures under `crates/patchbay-core/tests/fixtures/hooks` are payloads from
the installed CLIs. The Antigravity model was a loopback stub and Muse used the
built-in echo provider. Fixture coverage includes Antigravity lifecycle,
invocation, read and question payloads, and Muse lifecycle, model and subagent
payloads. Signed-in behavior and quota telemetry still need account validation.
