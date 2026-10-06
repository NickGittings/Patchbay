# Reviewed map maintenance

Choose **Project → Rescan** or **Rescan project** in the command palette. Patchbay scans the
project and approved component roots, then shows a review. Opening the review leaves the map
unchanged.

New components and dependencies start selected. Missing component removal, stale detected
link removal, and possible move repairs start unselected. A new folder that is a possible
move also starts unselected, so accepting the defaults does not duplicate the missing
component. Choose a repair or the corresponding new component. Dependencies selected with a
repair follow the original component ID.

**Apply selected** updates the draft. **Save** writes `patchbay.json`. Names, kinds, notes,
terminal configuration, positions, link labels, manual relationships, and component IDs
survive rescans and repairs. Edits made while a scan or guard is running invalidate that
preview; choose **Refresh preview**. Folder grants and available detectors are rechecked too.

Inspector shows the origin of each component or link. Hierarchy names expose origin in their
tooltip, and maintenance issues appear in both panels:

- **Missing**: an allowed folder no longer exists.
- **Locked**: the folder is outside granted roots, including a symlink escape. Choose
  **Browse…** to grant a specific folder.
- **Unreadable**: an allowed path cannot be read or is a file instead of a folder.

Checks run when a workspace opens, after folder/access changes, and on an explicit rescan.
They do not continuously replace the map. Missing/locked/unreadable folders never prove that
a dependency should be removed. Stale detected links require positive scan evidence for
both endpoints from the link's responsible detector and readable, valid manifests. Disabled,
unavailable, failed, and skipped detectors cannot establish removals. The current declarative
extension detectors report component markers rather than dependency snapshots, so they also
cannot prove old extension relationships stale; those links remain for explicit review.

Moves require an exact detector and declared package identity match between exactly one
missing component and exactly one new candidate. Built-in identities use declared npm,
Cargo, Python package names, or full Go module paths. Folder-only/native/requirements and
extension detectors without a package identity do not establish moves; use **Browse…**.

Before removing a component or changing its folder, stop its live sessions across all tasks
and stop managed environments that include it, including members without terminals. The same native guard applies to the
review, Inspector's folder input/Browse, and canvas Delete/Backspace. The session service
holds a brief lease during application so another start cannot race the edit. Removing a
component removes incident relationships and group/task scope references. Session history is
retained with its original recorded launch configuration; it is never rewritten to the
component's repaired path.

## Saved-map compatibility

Schema version 4 adds optional `detection` metadata to components and links:

```json
{"detector":"builtin","packageIdentity":"npm:@example/web"}
```

Built-in detection uses `builtin`; extension detection uses
`extension:<extension-id>:<detector-id>`. Explicit manual records use `manual`. Old maps,
including continuity recovery drafts, load without provenance and remain **Unclassified**.
A rescan does not silently classify them. **Mark manual** explicitly preserves their user
ownership. Provenance travels through React Flow conversion, saving, workspace drafts, and
extension project snapshots. Saving a legacy map writes the current schema version.

## Validation

Validation on macOS Apple Silicon, 2026-10-06:

- Rust formatting and workspace Clippy with warnings denied.
- Workspace tests, including reconciliation, legacy schema save, task pruning, session leases,
  environment ownership, native outdated previews, and existing lifecycle suites.
- Frontend TypeScript, Oxlint, Prettier checks and production build.
- Native `smoke:maintenance`: PASS.
- Affected native `smoke:actions`: PASS.
- Existing native `smoke:tasks`: PASS.

The existing macOS FSEvents lifecycle test times out inside the restricted sandbox; the
workspace suite succeeds when run with native filesystem-event access outside it. The build
retains the existing JavaScript bundle-size warning. No Windows/Linux desktop or packaged
release validation is implied by these macOS checks.

Run the focused desktop flow with:

```sh
cd apps/desktop
npm run smoke:maintenance
```

It creates an isolated temporary Git project, map, and session service. The fixture covers
safe additions, dependencies between existing/new components, stale links, unavailable
detectors, unique package moves with dependency remapping, legacy manual configuration,
missing/locked/unreadable folders, outdated draft/access previews, live-session path/removal
guards, group/task membership cleanup, explicit legacy classification, default selections,
responses arriving after a project switch, and Apply without saving. The action flow also
checks that a managed environment protects its members without terminals.

Windows/Linux native smoke, actual permission-denied directory behavior on each platform,
packaged release workflows, and the roadmap's developer trial remain release gates.
