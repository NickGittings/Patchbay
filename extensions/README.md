# Supported local integrations

Install `extensions/docker` and `extensions/preview` separately. They use the same opaque-origin
sandbox and permission broker as other extensions.

See [extension setup](../docs/extensions.md#installation) for installation, updates, and
development overrides.

## Docker Compose

Recognizes `compose.yaml`, `compose.yml`, `docker-compose.yaml`, and `docker-compose.yml`. Select a component and use its Docker actions or the Docker Compose Inspector view:

- **Refresh** queries all containers, including exited containers, and shows each state and health string.
- **Up** runs `docker compose up -d`.
- **Down** runs `docker compose down` for this component and workspace.
- **Logs** reads the last 200 log lines without following output.

Commands use the component’s folder in the originating task worktree. An explicit `patchbay-…` Compose project name is derived from project ID, task ID and component ID. Separate tasks therefore have separate containers, even when their folders have the same basename. Containers created outside Patchbay under another Compose project name are not managed. Port conflicts remain ordinary Compose errors; choose different published ports for simultaneous tasks.

Docker with its Compose plugin and an accessible daemon must be installed. A failed, unavailable, malformed, or still-running query displays an explanation and retains timestamped last-successful results as stale. An unqueried component is **Not refreshed**. Up/Down mark prior results stale; Refresh updates them. Activation never queries or starts Docker automatically. Sessions run through the normal terminal policy; commands can be inspected and stopped in the terminal dock. The fixture in `docker/fixture` uses nginx and port 8080; running Up downloads that image if needed.

## Browser previews

Select a component, then use **Preview: Refresh URLs** or the Browser previews Inspector tab. Refresh lists HTTP/HTTPS URLs reported by that component’s task terminals in the originating task. It reads bounded summaries without exposing raw terminal content or agent prompts. Save additional URLs in the view; saved URLs belong to that project/task/component and live in local extension storage. **Open** uses the system browser. Opening or refreshing a preview does not start its server.

The extension declares `sessions:read` and a separate `urls:open` permission. The native broker validates HTTP/HTTPS and rejects credentials, whitespace, controls, and other protocols. Sandbox network access remains disabled. To try the fixture, add a task terminal with `node server.mjs` in `preview/fixture`, start it, then Refresh and Open `http://127.0.0.1:3037`.

Hosts, commands, views, subscriptions, badges and delayed results retain their originating project/task. Switching workspaces preserves running environments; inactive hosts cannot publish views or messages into the active workspace. Disabling/reloading extensions disposes their subscriptions.

## Validation

Run `node extensions/tests.mjs` for deterministic Docker success/absent/failing/stale results, stable Compose scopes, preview URL storage/validation and stale-action/result checks. Core regressions cover native URL validation, permissions, summary boundaries, denied roots and generation/history exclusion. `npm run smoke:integrations` in `apps/desktop` exercises the native broker, task launches/file reads, retained hosts, explicit Docker results, and preview refresh without server start. `npm run smoke:extensions` retains the existing third-party sandbox probe.

macOS native checks are recorded in `VALIDATION.md`. Real Docker daemon operations and packaged Windows/Linux checks are required before claiming release readiness on those platforms.
