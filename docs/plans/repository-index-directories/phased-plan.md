# Indexed directories: phased implementation

Implementation index for [`plan.md`](plan.md), which the human approved with four submitted
decisions. This document is the merge-aware decomposition of that plan and the record of what the
repository said about it.

## Source plan and incorporated decisions

Source of truth: [`plan.md`](plan.md), rendered at [`plan.html`](plan.html). Mock-ups in
[`mockups/`](mockups/index.html), of which `a-directory-rows.html` is the adopted design.

Submitted in the dashboard plan review and already written into `plan.md`:

| Decision | Answer | Consequence for implementation |
| --- | --- | --- |
| Panel shape | A - directory rows | Per-row status chip, per-row Remove, an Add field, Restore defaults, Rescan now. Not a matrix, not a textarea. |
| Removal model | Remove only, plus Restore defaults | The stored row is `{ path }` with no `enabled` field. There is no per-directory toggle to build, test, or back up. |
| Environment precedence | `MISSION_WORKSPACE_DIRS` wins, panel read-only | `indexedDirectories()` returns the override untouched when it is set, and the panel renders a read-only list plus the variable's value. |
| After this plan | Create phased implementation plan | This document and its one phase. |

## What the repository said

Investigated against the current checkout before the phase boundaries were drawn. Four findings
changed the plan's shape; the rest confirmed it.

1. **A layer split would land red, so the vertical slice cannot be broken up.**
   `test/settings-backup-coverage.test.ts` asserts that every backup domain whose surface is
   `settings` is referenced by at least one entry in `SETTINGS_CONTROLS`
   (`src/web/lib/settings-search.ts`), and separately that the config-derived domain set equals the
   `settings` plus `runtime` domain set exactly. `test/settings-search.test.ts` then asserts that
   every control's anchor is one the rendered `SettingsPage` actually carries. So the moment the
   `repoIndex` app-config entry and its `repo-index` backup domain exist, the browser panel, its
   anchors, and its search-index entries must exist too, or the suite fails. A server-first phase
   is not an option here, and that is the whole reason this is one phase.

2. **The panel must render its controls before its first poll returns.** Both settings render tests
   drive `SettingsPage` through `renderToStaticMarkup` with null subsystem state and no effects.
   `DispatchSettingsPanel` documents the resulting contract: a daemon-backed panel renders
   disabled-but-present until its read lands. `RepositoriesPanel` has to follow it, which is a
   design constraint on the component, not a test detail.

3. **The e2e fixture needs one conditional, not a config-seeding mechanism.**
   `e2e/fixtures/daemon.ts` sets both `HOME` and `MISSION_HOME` to the throwaway home and seeds its
   repository into `join(home, "workspace")`. The shipped default `~/workspace` therefore already
   expands to exactly the fixture workspace. The new spec needs the fixture to *omit*
   `MISSION_WORKSPACE_DIRS` under an opt-in flag - after which discovery finds the seeded repo
   through the default config path - rather than the config-row seeding the source plan assumed.
   The plan's "fixture change this needs" note is resolved in the phase file accordingly.

4. **Adding a settings category has a documented checklist wider than the plan listed.**
   `docs/agent-guides/change-contracts.md#registries` requires `SETTINGS_CATEGORIES`,
   `renderCategory`, the panel component, and the search anchors together, and states that
   categories are unconditional destinations with no availability filter. It also requires README
   updates for a new capability and for a changed environment variable, and
   `docs/skills-and-settings.md` carries both a per-group category table and a "thirteen
   categories" count that becomes wrong.

Confirmed as the plan assumed:

- `src/server/shipping/config.ts` is the exact pattern for a schema blob over `app_config`
  (`getAppConfig`/`setAppConfig` against an `APP_CONFIG_ENTRIES` descriptor), and `useShipping.ts`
  is the pattern for a polling hook with a write guard.
- No SQLite migration is needed: `app_config` is a key-value partition, and `logicalConfigValue`
  handles a `generic` capture entry with no new case.
- `settingsRailDot` needs no new branch - a category with nothing to flag returns null - and the
  ⌘K palette reads `SETTINGS_CONTROLS`, so it needs no provider change.
- `listRepos()`'s 30-second cache, `scanRepos([]) === []`, and `MAX_DEPTH`/`SKIP` are all as
  described.

## Sizing and phase count

**Estimate: 600 to 750 gross non-test implementation lines**, excluding tests and documentation
prose. Assumptions behind the range: this repository's house style carries substantial explanatory
doc comments (the estimate includes them), `src/web/styles.css` rules for the row list are counted
as implementation, and the four documentation files are not.

Rough distribution: shared contract ~90; app-config and backup-domain registration ~10; server
config, expansion, validation and status probe ~170; `repos.ts` edits ~25; three routes ~35; the
polling hook ~90; `RepositoriesPanel.tsx` ~190; registry, search index and `SettingsPage` wiring
~50; stylesheet ~90.

**One phase, one task.** Above 200 lines the rubric's default is still a single phase, and here the
default is also the only safe option: finding 1 shows that any split along the shared/server/web
boundary leaves the repository failing its own settings-coverage and anchor-integrity tests at the
intermediate merge. The alternatives were considered and rejected:

- *Server first, panel second* - fails `settings-backup-coverage.test.ts` and
  `settings-search.test.ts` on merge of phase one, which violates the rule that a phase ends with
  an operable, testable repository.
- *Panel first, server second* - a panel with no route behind it is a dead surface and a second
  source of truth for the default list.
- *Feature first, e2e spec second* - the repository requires the Playwright spec in the change that
  alters the UI. A test-only follow-up phase is exactly the kind of phase the rubric forbids.

The work is also one coherent slice for a mid-tier model: one config key, one server module, one
route trio, one panel, and the four registry lines that tie them together.

## Phases

| Phase | Name | Depends on | Repository | Outcome |
| --- | --- | --- | --- | --- |
| 1 | [Repositories settings and config-backed discovery](phase-1-repositories-settings-and-config-backed-discovery.md) | This planning session's pull request | current (`mission-control`) | Repository detection reads its directory list from `app_config`, seeded with the four defaults, and Settings gains the Repositories category that edits it. |

Dependency graph: `planning PR merge → Phase 1`. Nothing runs concurrently, because there is
nothing else to run.

## Cross-phase contracts

With one phase there is no inter-phase contract to hold. What the phase must not quietly change,
because other subsystems already depend on it:

- `MISSION_WORKSPACE_DIRS` keeps precedence and keeps its colon-separated syntax. Every e2e spec,
  Demo mode, `test/pipeline-http.test.ts` and `test/mcp-create-task.test.ts` rely on it.
- `listRepos()` keeps its signature, its cache, and its "never descend into a repo" rule. Four
  callers read it.
- `SETTINGS_BACKUP_DOMAINS` and `APP_CONFIG_ENTRIES` are append-only.
- Indexing grants nothing. The Foreman, Workflows, Inspector and Shipping allowlists are untouched.

## Final verification

Owned by the phase and stated in its file: the extended `test/repos.test.ts`, the new
`test/repo-index-http.test.ts`, the settings registry and backup coverage tests, `npm run
typecheck`, `npm run lint`, `npm run build`, and the new `e2e/specs/settings-repository-index.spec.ts`
under `npm run test:e2e`.
