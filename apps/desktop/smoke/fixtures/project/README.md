# Desktop smoke fixture

This portable `patchbay.json` supplies the default map for the pop-out, views, Git,
workspace, and sessions smoke tests. Keep it tracked and independent of the local
map at the repository root.

The runner copies this folder into a fresh temporary Git repository for each test.
Workspace and sessions tests get two separate copies with distinct project names.
Tests may change those copies without changing these files or a developer's map.
The Docker extension fixture is also copied; its map is detected in the temporary folder.
The `app` folder supplies shell sessions and file-tree entries; `crates` and
`devices` supply paths used by the Git watcher and component merge checks.
Other smoke tests retain their own explicit fixtures.
