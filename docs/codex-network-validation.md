# Scoped Codex access to the desktop bridge

Patchbay keeps its authenticated, version 1 TCP bridge. Interactive Codex planner,
implementation, review, and merge launches receive invocation-local command networking
settings. The command network proxy is enabled with SOCKS5 support, an exact
`127.0.0.1` allowance, and `allow_local_binding = false`. Existing destination rules,
explicit denies, filesystem restrictions, model/profile options, and approval settings
are retained. No global Codex configuration is written.

Codex 0.167.0 on macOS still denies raw TCP sockets under its enforced network proxy,
even to an allowed loopback address. The CLI therefore tunnels the existing bridge
protocol through the managed SOCKS5 listener when both `PATCHBAY_REPORT_PROVIDER=codex`
and `CODEX_NETWORK_PROXY_ACTIVE=1` identify the session. It uses Codex's `ALL_PROXY`
(or lowercase equivalent), requires a loopback IP listener without proxy credentials,
and never falls back to a direct socket after a proxy failure. Other providers and
ordinary shell proxy settings continue to use direct TCP. Bridge tokens, launch-bound
roles, proposal validation, and Apply selection behavior are unchanged.

Patchbay asks Codex's app server for its configuration layers and managed requirements
before enabling command networking. Only active layers can contribute allowances or
permission selection; inactive project layers contribute conservative denies only.
Selected legacy or file-based profile defaults precede trusted project overrides.
The profile directory comes from the probe's user-layer metadata, including a
`CODEX_HOME` exported only by the login shell. A missing selected profile is an
inspection failure rather than an empty set of defaults. The original preset is
checked by launch policy before inspection; the decorated command is checked again.
Denies found in earlier layers are retained, including the selected profile's parents.
Named permission profiles retain their filesystem and inheritance; built-in profiles
use an invocation-local derived profile. Legacy workspace-write launches retain their
writable roots and temporary-directory exclusions. Native Codex review continues to
use `exec --sandbox read-only review ... -o ...` without additional networking settings.

Unresolvable configuration, explicit working-directory overrides, remote servers, legacy read-only/full-access modes, and
sandbox-bypass presets receive a launch notice instead of a permission change. Codex
feature-toggle presets for `network_proxy` must use a configuration table so their
rules can be preserved. Unresolved toggles, variable option names, and expansions
that could introduce additional arguments leave networking unchanged. Quoted POSIX
scalar option values retain their original syntax. Oversized generated settings are
rejected before changing the command or its environment, including space for the
briefing, directories, and reserved kickoff prompt.
`--strict-config` makes unsupported CLI configuration fail
visibly. Unavailable configuration metadata or a managed pin disabling the proxy
leaves networking settings unchanged. Managed network policy remains authoritative; an explicit deny or exclusive
administrator allowlist can prevent bridge access. Patchbay does not bypass it.

Restart existing agent sessions to receive changed launch settings. Reopening the
desktop only refreshes its endpoint file; it cannot change a running agent's sandbox.
A loopback IP allowance also permits other services at that IP through the proxy;
the bridge's capability token still authenticates every request. Saving plans before
Git initialization remains a separate storage limitation.

## Verification

The installed CLI used for verification was `codex-cli 0.167.0` on macOS.

Run the installed-sandbox desktop check from `apps/desktop`:

```sh
node scripts/smoke-all.mjs codex-network
```

This explicit suite requires an installed Codex CLI and a desktop session. It uses
scratch repositories and a temporary `CODEX_HOME`, with a scripted provider that runs
the real `codex sandbox` and its managed proxy. It makes no model calls. The standalone
sandbox selects its named permission profile explicitly and does not accept the TUI's
`--strict-config` flag.

The suite reproduces the original permission-denied status request under restricted
networking, then verifies a sandboxed planner's saved plan and proposal appear in the
Plan view without changing scope or starting implementation agents. An implementation
session exercises status and the configured validator. It also checks a blocked raw
socket, an unapproved destination, an explicit feature-level loopback deny, a named
profile loopback deny, and a denied write outside the workspace.

Core regression tests cover SOCKS framing and authentication handoff, proxy rejection
without direct fallback, permission-specific errors, provider isolation, launch and
resume argument preservation, native review's read-only output handoff, and desktop
restart/reconnection. The existing `tasks` desktop smoke covers Apply selection,
configured checks, and task-bound commands. Windows and Linux native sandbox execution
and managed enterprise policy deployment need their own environment verification.

The additional `merge` desktop smoke completes its merge operations but times out
waiting for the finished destination session row. The same timeout was reproduced
in an isolated checkout of `main` at `b1d60d1`; it predates this change.

The configuration follows the official OpenAI documentation for
[command networking](https://learn.chatgpt.com/docs/permissions) and
[configuration keys](https://learn.chatgpt.com/docs/config-file/config-reference).
