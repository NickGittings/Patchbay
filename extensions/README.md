# Supported local integrations

Install `extensions/docker`, `extensions/preview`, `extensions/story-import`,
`extensions/github-issues` and `extensions/linear` separately. They use the same opaque-origin
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

## Story import from files

**Import from file…** in the story board header reads a `.json`, `.csv` or `.md` file you choose:

- **JSON**: an array of items (or `{ "items": [...] }`) with `id`, `kind` (`epic`, `feature` or
  `story`), `title`, `parent`, `description`, `acceptance` and `url`. Items may nest `children`.
- **CSV**: a header row. Jira and Azure DevOps export columns work, including `Issue key`,
  `Issue Type`/`Work Item Type`, `Summary`/`Title`, `Parent`/`Epic Link`, `Description` and
  `Acceptance Criteria` (one criterion per line).
- **Markdown**: `#` epics, `##` features and `###` stories; text below a heading is its
  description and `- [ ]` lines are acceptance criteria.

Types other than epic and feature become stories. A story directly under an epic goes under a
feature named after that epic, and a feature without an epic goes under an "Imported" epic.
CSV rows without an ID use their kind, parent and title, so inserting an unrelated row preserves
their identities. For rows that share all three, the importer counts occurrences within that group.
Include explicit IDs when you want edits to those fields to update the same cards. CSV rows
previously imported with row-number IDs are matched by kind and title when the match is
unambiguous. Supply the old ID explicitly for ambiguous rows. Fixtures are in `story-import/fixture`.

## GitHub Issues and Linear

Both add a rail button under **Extensions** and an import button in the story board header.
They only read from the tracker.

- **GitHub Issues** imports a repository's open issues (optionally filtered by labels): the
  repository becomes an epic, milestones become features and issues become stories. Task-list
  items in an issue become acceptance criteria. Pull requests are skipped. Public repositories
  work without a token; set a fine-grained token with read-only Issues access for private ones.
  For GitHub Enterprise Server, enter its API address (`https://host/api/v3`) and approve that
  origin in **Settings → Extensions**.
- **Linear** imports a team's issues (open only, unless you include completed ones):
  initiatives become epics, projects become features and issues become stories. Projects
  outside an initiative go under one epic for the team. It needs a personal API key.

Tokens are saved in the OS keychain through Patchbay's own prompt. Imports read at most 1,000
issues.

## Validation

Run `node extensions/tests.mjs` for deterministic Docker success/absent/failing/stale results, stable Compose scopes, preview URL storage/validation, stale-action/result checks, and the story import, GitHub Issues and Linear mappings and pagination (with stubbed responses; no tracker account is needed). Core regressions cover native URL validation, permissions, summary boundaries, denied roots and generation/history exclusion. `npm run smoke:integrations` in `apps/desktop` exercises the native broker, task launches/file reads, retained hosts, explicit Docker results, and preview refresh without server start. `npm run smoke:extensions` retains the existing third-party sandbox probe.

macOS native checks are recorded in `VALIDATION.md`. Real Docker daemon operations and packaged Windows/Linux checks are required before claiming release readiness on those platforms.
