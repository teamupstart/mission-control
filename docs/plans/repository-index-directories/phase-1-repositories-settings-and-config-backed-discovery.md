# Phase 1: Repositories settings and config-backed discovery

The only phase. See [`phased-plan.md`](phased-plan.md) for why the work is not split, and
[`plan.md`](plan.md) for the approved goal and the four submitted decisions.

## Outcome and value

Repository detection stops being a hard-coded `~/workspace` plus an environment variable nobody can
see. It reads a directory list from `app_config`, shipped seeded with `~/workspace`, `~/code`,
`~/dev` and `~/upstart`, and Settings gains a **Repositories** category that adds to that list,
removes from it (seeded rows included), restores the defaults, and rescans on demand.

Two things a person can do afterwards that they cannot do now: find a checkout that lives in
`~/code` in the dispatch repo picker without typing its path, and stop the daemon walking a
directory they do not keep code in.

## Entry criteria and dependencies

- The planning session's pull request has merged, so this file, `phased-plan.md` and `plan.md` are
  on the default branch. That is the only dependency; there is no earlier phase.
- No migration prerequisite. `app_config` is a key-value partition and this adds a key.

## Scope

In scope: the shared contract, the app-config and backup-domain registration, the server config
module and its validation, the `repos.ts` delegation and cache invalidation, three routes, the
polling hook, the panel, the four registry/wiring lines, the stylesheet rules, the node tests, the
Playwright spec and its fixture flag, and the four documentation updates.

Explicit non-goals:

- **No scan-depth or skip-list setting.** `MISSION_REPOS_MAX_DEPTH` and the `SKIP` set in
  `repos.ts` stay exactly as they are.
- **No include/exclude patterns and no directory watching.** Rescan now plus the existing 30-second
  cache is the whole freshness story.
- **No per-directory enable toggle.** The submitted decision is remove-only; the stored row is
  `{ path }` and gains no second field.
- **No change to any allowlist.** Indexing a directory offers its checkouts in a picker and grants
  nothing. Foreman, Workflows, Inspector and Shipping are untouched, which is also why the category
  sits in *Sessions* rather than beside Trust.
- **No change to `listRepos()`'s contract**, its cache TTL, or its refusal to descend into a repo.

## Repository findings this phase must respect

Verified against the checkout during planning. These are the four that change how the work is
written; `phased-plan.md` records the rest.

1. **Coverage invariants tie the server and the browser together.**
   `test/settings-backup-coverage.test.ts` requires that every `settings`-surface backup domain is
   named by at least one `SETTINGS_CONTROLS` entry, and that the config-derived domain set equals
   the `settings` plus `runtime` set exactly. `test/settings-search.test.ts` requires that every
   control's anchor is rendered by `SettingsPage`. Land the config entry, the backup domain, the
   search entries and the panel in this one change or the suite fails.

2. **The panel renders before its first read returns.** Both settings render tests use
   `renderToStaticMarkup` with null state and run no effects. Follow the contract
   `DispatchSettingsPanel`'s doc comment states: render the rows region and every anchor
   immediately, disabled, with an "unknown" reading until the poll lands. A panel that returns
   `null` while `config === null` fails the anchor-integrity test.

3. **The e2e fixture needs a flag, not config seeding.** `e2e/fixtures/daemon.ts` sets
   `HOME` and `MISSION_HOME` to the throwaway home and seeds its repo into `join(home,
   "workspace")`, so the shipped default `~/workspace` already resolves to the fixture workspace.
   The spec needs the fixture to omit `MISSION_WORKSPACE_DIRS` under an opt-in flag; it does not
   need a way to write the config row before start.

4. **`docs/agent-guides/change-contracts.md#registries`** requires `SETTINGS_CATEGORIES`,
   `renderCategory`, the panel and the search anchors together, with categories as unconditional
   destinations - no availability filter, no conditional rail row. It also requires README updates
   for a new capability and for a changed environment variable.

## Implementation steps, in execution order

### 1. Shared contract - `src/shared/repo-index.ts` (new)

Browser-safe, no `node:` import; `~` expansion and `stat` belong to the server.

- `DEFAULT_INDEXED_DIRECTORIES = ["~/workspace", "~/code", "~/dev", "~/upstart"] as const`.
- `IndexedDirectorySchema = z.object({ path: z.string().trim().min(1) })`.
- `RepoIndexConfigSchema = z.object({ directories: z.array(IndexedDirectorySchema).default(...) })`,
  the default being the four materialized as rows. Document why the default lives here: Zod applies
  it only for `undefined`, so an unwritten key yields the four while a stored `[]` stays empty, and
  that is what makes the defaults seeded-but-removable with no migration.
- `RepoIndexConfigPatchSchema` - `RepoIndexConfigSchema.partial()`.
- `INDEXED_DIRECTORY_STATUSES = ["ok", "missing", "not-a-directory", "unreadable"] as const` and its
  type.
- `IndexedDirectoryView` - `{ path, resolved: string | null, status, repoCount: number | null,
  isDefault: boolean }`.
- `RepoIndexView` - `{ directories: IndexedDirectoryView[], managedBy: "config" | "environment",
  environmentVariable: string | null, environmentValue: string | null, savedDirectories:
  IndexedDirectoryView[], defaultsMissing: string[], repoCount: number, scannedAt: number }`.
  `savedDirectories` is what the panel shows under "Saved here, currently ignored" when the
  environment wins, and is empty otherwise.
- `MAX_INDEXED_DIRECTORIES = 16`.

### 2. Registry registration

- `src/shared/settings-backup-domains.ts`: append `{ id: "repo-index", surface: "settings" }` as the
  last `settings` entry. Never reorder the existing ids.
- `src/shared/app-config-entries.ts`: add
  `const repoIndexFields = { directories: "setting" } satisfies Record<keyof RepoIndexConfig,
  AppConfigValueClass>` and
  `repoIndex: fieldsEntry("repoIndex", RepoIndexConfigSchema, "repo-index", repoIndexFields)`.
  Capture stays `generic`, so `logicalConfigValue` needs no new case.

### 3. Server config - `src/server/repo-index.ts` (new)

Mirror `src/server/shipping/config.ts`.

- `getRepoIndexConfig()` / `setRepoIndexConfig(patch)` over `getAppConfig`/`setAppConfig` with the
  `APP_CONFIG_ENTRIES.repoIndex` descriptor. `setRepoIndexConfig` validates, persists, calls
  `invalidateReposCache()`, and returns the stored config.
- `expandHome(path)` - the single place `~` becomes `homedir()`. Handle `~` alone and `~/x`; leave
  everything else untouched.
- `environmentDirectories()` - the existing `envVar("WORKSPACE_DIRS") ?? envVar("WORKSPACE_DIR")`
  read, split on `:`, trimmed, emptied entries dropped. Moved here from `repos.ts` so precedence
  lives in one module.
- `indexedDirectories(): string[]` - the environment list when non-empty, otherwise the configured
  paths expanded and deduplicated. Synchronous, because `workspaceRoots()` is.
- `canonicalize(path)` - `expandHome`, then `resolve()` so `..` and `.` segments are gone, then
  `realpathSync` when the path exists so a symlink cannot smuggle in a different target. Returns the
  canonical absolute path; for a path that does not exist yet, the normalized-but-unresolved form is
  the answer.
- `validateIndexedDirectories(rows)` - canonicalize first, then refuse with a message the panel
  prints verbatim:
  - empty or whitespace-only path;
  - not absolute after expansion;
  - **at or above the home directory**: the canonical path is the filesystem root, equals the home
    directory, or is an ancestor of it. This is a containment test on path segments, not three
    equality checks, and canonicalizing before it is the point - `~/..`, `/Users/me/..` and
    `/Users` are all ancestors of home that equal none of those literals, and each would turn the
    depth-3 walk into a scan of every user's files. Compare segment-wise (`/Users` versus
    `/Users2`) rather than by string prefix.
  - a duplicate of another row after canonicalization;
  - more than `MAX_INDEXED_DIRECTORIES` rows.

  A directory that simply does not exist is accepted and reported as `missing`, because a path can
  be created after it is configured. That is also why the ancestor test must work on the normalized
  path rather than relying on `realpath`: an operator can name a not-yet-existing
  `~/projects/../../..`, which has no `realpath` to resolve.
- `repoIndexView()` - async. Probes each configured path with `stat` and `realpath`, counts the
  repos each contributes from the scan, and reports `managedBy`. Under an environment override the
  primary list is the override's directories and `savedDirectories` is the configured list with no
  counts.

### 4. Discovery - `src/server/repos.ts`

- `workspaceRoots()` delegates to `indexedDirectories()`. Replace its doc comment's
  "Defaults to `~/workspace`" with the setting and the override's precedence.
- Export `invalidateReposCache()` which nulls the module cache.
- Leave `scan`, `scanRepos`, `MAX_DEPTH`, `SKIP`, `CACHE_TTL_MS`, `listRepos` and
  `resolveTaskRepoRoot` alone.

### 5. Routes - `src/server/routes.ts`

Beside the other config routes, following `/api/shipping/config`:

- `GET /api/repo-index` returns `await repoIndexView()`.
- `PUT /api/repo-index` parses `RepoIndexConfigPatchSchema` through `parseBody`, returns 400 with
  the validation message on refusal, otherwise writes and returns the fresh view.
- `POST /api/repo-index/rescan` invalidates the cache and returns the fresh view.

No `publishSettingsStatus` call: this category has no rail dot, because there is no armed state to
flag.

### 6. Browser state - `src/web/useRepoIndex.ts` (new)

Model on `useShipping.ts`: 4s poll, a `writes` ref so a poll started before a write cannot restore
what the write removed, an `error` string cleared by the next accepted edit. Expose `view`,
`update(patch)`, `addDirectory(path)`, `removeDirectory(path)`, `restoreDefaults()`,
`rescan()`, `error`. Add `fetchRepoIndex` to `src/web/lib/api.ts` beside `fetchShippingConfig`.

### 7. Panel - `src/web/components/RepositoriesPanel.tsx` (new)

Follow `mockups/a-directory-rows.html`, which is the adopted design, and its four states.

- Blurb naming the three surfaces that read the list and stating that indexing grants nothing.
- `data-anchor="repositories/directories"` on the rows region, `repositories/add` on the add field,
  `repositories/rescan` on the rescan button. All three render on a null view, disabled - see
  finding 2.
- One row per directory: path, a `default` chip where the path is one of the four, a status chip
  (`N repositories`, `not found`, `not a directory`, `unreadable`), and Remove. No confirm dialog:
  removal stops a walk and deletes nothing.
- Add field with the daemon's refusal printed beneath it, Restore defaults shown when
  `defaultsMissing` is non-empty, Rescan now with the indexed count.
- Empty state that says what stops working rather than rendering a blank list.
- Environment state: a `settings-warn` block naming the variable and its value, the effective list
  read-only, the saved list beneath it, and no editing controls.
- Select by role, label and placeholder only. No `data-testid`, and no new `aria-label` that
  duplicates visible text.

### 8. Wiring

- `src/web/lib/settings-registry.ts`: a `repositories` category after `worktrees` in the `sessions`
  group, scope `machine`, icon a single glyph consistent with its peers, blurb, and keywords
  `repository`, `index`, `scan`, `directory`, `workspace`, `discovery`, `picker`, `folder`.
- `src/web/lib/settings-search.ts`: three controls, all `kind: "jump"`, backed by
  `backupDomains("repo-index")`, anchored at the three anchors above.
- `src/web/components/SettingsPage.tsx`: the `useRepoIndex()` call and one
  `case "repositories"` in `renderCategory`.
- `src/web/styles.css`: the row-list rules in the settings section of the stylesheet. Reuse existing
  tokens; name no new colour.

### 9. Tests

- `test/repos.test.ts` - extend: configured directories are scanned; the environment override wins
  over a configured list; `~` is expanded; duplicates collapse after `realpath`; an empty list scans
  nothing; an absent config key yields the four defaults.
- `test/repo-index-http.test.ts` (new) - the view's shape including `status` and `repoCount`; each
  validation refusal with its message, including the ancestor cases (`~/..`, `<home>/..`, the
  directory holding the home directory, and a not-yet-existing path whose `..` segments climb above
  home) and a near-miss that must be ACCEPTED (a sibling of home such as `<parent>/me2/code`, so
  the containment test is not a string prefix); a removal that survives a re-read; `[]` staying empty rather
  than re-defaulting; Restore defaults adding only what is missing; and a repo created after the
  first read appearing after a write, which is the cache-invalidation assertion. Set
  `MISSION_HOME` above the imports, per the suite's isolation contract in `CLAUDE.md`.
- `e2e/specs/settings-repository-index.spec.ts` (new) - open Settings, select Repositories, assert
  the four seeded rows and that the `~/workspace` row reports the fixture's repo; remove `~/dev`
  (a default that is NOT the fixture workspace, and which reports `not found` there), assert it is
  still gone after a reload, and assert the dispatch repo picker still offers the fixture repo;
  then Restore defaults and assert `~/dev` is back. Drive the fixture with the new flag so
  `MISSION_WORKSPACE_DIRS` is unset and the shipped default resolves to the fixture workspace
  (finding 3). No agent is launched, so no tokens are spent.

  Remove `~/dev` specifically, not any row: `~/workspace` IS the fixture workspace under finding 3,
  so removing it empties the picker and re-adding it hits the duplicate refusal instead of the
  picker assertion. If the spec ever needs to exercise the workspace row's own round trip, remove
  it and use Restore defaults to bring it back rather than adding the path again.
- `e2e/fixtures/daemon.ts` - the opt-in flag that omits `MISSION_WORKSPACE_DIRS`. Every existing
  spec keeps the environment path unchanged, and `e2e/README.md`'s environment table gains the flag.

### 10. Documentation

- `README.md` - the feature section for the new capability, and the Configuration entry for
  `MISSION_WORKSPACE_DIRS` now being an override.
- `docs/configuration.md` - the `MISSION_WORKSPACE_DIRS` row becomes an override of Settings ›
  Repositories.
- `docs/dispatch-and-backlog.md` - the repo picker paragraph names the setting instead of
  `~/workspace`.
- `docs/skills-and-settings.md` - the Sessions row of the category table gains Repositories, and the
  "thirteen categories" count becomes fourteen.

## Data, API and compatibility

- **No SQLite migration.** One new `app_config` key. An older database has no `repoIndex` row and
  therefore reads the four defaults on first open, which is the intended upgrade behavior.
- **Downgrade.** An older build ignores the key and falls back to `~/workspace` plus the
  environment variable. Nothing is lost, and the key is picked up again on upgrade.
- **Backups.** The new domain participates in settings snapshots automatically, because the backup
  service enumerates `APP_CONFIG_ENTRIES`. Restore therefore round-trips the list, including an
  intentionally empty one.
- **Environment precedence** is unchanged for every existing caller.

## Verification

```sh
node --test --import ./test/setup-state.mjs --import tsx test/repos.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/repo-index-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/settings-search.test.ts test/settings-sidebar-render.test.ts test/settings-backup-coverage.test.ts
npm run typecheck
npm run lint
npm run build
npx playwright test e2e/specs/settings-repository-index.spec.ts
```

Then `npm test` and `npm run test:e2e` before requesting review, since this touches shared
registries that other suites read. Attach the panel's rendered states as pull-request evidence; the
mock-up is a drawing, and the claim is about the built dashboard.

## Merge and exit criteria

- The four defaults are indexed on a database that has never stored the key, and a checkout in a
  seeded directory is offered by the dispatch picker without typing a path.
- Removing a directory, including a seeded one, survives a reload and a daemon restart; removing all
  four leaves nothing indexed and says so.
- Restore defaults adds back only missing defaults and leaves operator-added directories alone.
- A refused path is reported with the daemon's reason and is not stored.
- With `MISSION_WORKSPACE_DIRS` set, the daemon indexes exactly it and the panel is read-only and
  names the variable.
- The listed verification passes, including the new Playwright spec, and the four documentation
  files match the implementation.

## Downstream handoff

No later phase depends on this one. What a future change may rely on, and should not break silently:

- `indexedDirectories()` is the one answer to "which directories are walked", and
  `MISSION_WORKSPACE_DIRS` outranks it.
- `invalidateReposCache()` is the seam for anything that changes the answer.
- `repoIndex` in `app_config` and `repo-index` in `SETTINGS_BACKUP_DOMAINS` are append-only ids.
- `repositories/directories`, `repositories/add` and `repositories/rescan` are the stable anchors the
  settings search index points at; renaming one breaks that index.

## Cross-phase audit record

- **Initial (this file, sole phase).** Every requirement in `plan.md` and all four submitted
  decisions are owned here: panel shape (step 7), remove-only with Restore defaults (steps 1, 3, 7),
  environment precedence (steps 3, 7), and the seeded defaults (step 1). No requirement is deferred
  and no cleanup is left to an unwritten phase.
- **Deviation from `plan.md` recorded during investigation.** The plan proposed that the e2e fixture
  seed the `repoIndex` config row; the repository shows a flag omitting `MISSION_WORKSPACE_DIRS` is
  sufficient and simpler, because the fixture's `HOME` already makes `~/workspace` the fixture
  workspace. Adopted here, and the reason is stated in finding 3.
- **Addition beyond `plan.md`.** `savedDirectories` on the view, so the environment state can show
  the ignored-but-kept list the adopted mock-up draws. The plan's prose implied it; the contract now
  names it.
- **Addition beyond `plan.md`.** The README and `docs/skills-and-settings.md` updates, required by
  the registries and documentation contracts, which the plan's documentation list omitted.
- **Review round 2 (Inspector, PR #802).** The broad-root refusal was specified as equality against
  `/` and the home directory, which `~/..`, `<home>/..` and `/Users` all pass while still making the
  depth-3 walk scan every user's files. Step 3 now canonicalizes (expand, `resolve`, `realpath` where
  the path exists) before a segment-wise containment test that refuses the root, the home directory,
  and any ancestor of it, and step 9 pins the ancestor cases plus a sibling-of-home path that must
  still be accepted. `plan.md` carries the same rule. No approved decision changed; this closed a
  hole in a safety check the plan already intended.
- **Review round 1 (Inspector, PR #802).** The e2e scenario named "remove one row, then add the
  fixture workspace", which finding 3 makes impossible: `~/workspace` already IS the fixture
  workspace, so the add lands on the duplicate refusal. Step 9 and `plan.md` now name `~/dev` as
  the row to remove and use Restore defaults for the return trip. No approved decision changed;
  this corrected a scenario the fixture decision had already invalidated.
