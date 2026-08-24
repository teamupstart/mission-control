# Phased implementation: daily settings backup and restore

- **Source plan:** [`plan.md`](plan.md) (rendered: [`plan.html`](plan.html))
- **Approved review:** `ab03c39b-0ed0-4ac1-8f02-4241656cf162`
- **Date:** 2026-08-24
- **Phases:** 3
- **Tasks:** 3
- **Repository:** this Mission Control checkout only

## Incorporated human decisions

The submitted selections are requirements, not open questions.

| Decision | Selection |
| --- | --- |
| Snapshot architecture | **Versioned logical JSON** |
| Retention | **90 daily plus 10 pre-restore safety snapshots** |
| Forward compatibility | **Every supported new setting is automatic or makes typecheck or CI fail** |
| Follow-up | **Create and schedule a phased implementation plan** |

## Investigated repository findings

The source plan was checked against the current persistence, workflow, daemon, browser, and test
contracts. These findings determine the merge boundaries.

1. **`app_config` is a mixed-purpose KV table, and two values are mixed-purpose internally.**
   Typed operator configuration uses `harnesses`, `worktrees`, `skills`, `cost`, `foreman`,
   `foreman.instructions`, `workflows`, `taskSources`, `llm`, `away`,
   `instructions.standing`, `inspector`, `shipping`, `pipelines`, and `ui`. The same table also
   stores `foreman.lease`, `backlog.plan`, `costTelemetryEnabledAt`, and `costOtelLastSeen`.
   Further, `skills` mixes the operator's `enabled` and `skills` choices with the derived
   `generation` and `generationAt` watermarks, while `away` mixes stall thresholds with the current
   `away` and `awaySince` state. A whole-table or whole-object copy is therefore unsafe.

2. **The automatic-or-red invariant needs exhaustive field classification, not only key
   classification.** `getAppConfig` and `setAppConfig` currently accept arbitrary strings. Their
   supported replacement will accept an `APP_CONFIG_ENTRIES` descriptor. Every descriptor either
   classifies the whole value or provides an exhaustive
   `Record<keyof Config, "setting" | "derived" | "operational">`. A schema field cannot be added
   without choosing a classification; a field classified as `setting` is included by generic
   capture and merge restore without editing the backup service.

3. **The existing Settings search index is the control-level enforcement point.**
   `src/web/lib/settings-search.ts` states that `SETTINGS_CONTROLS` is the one list of everything the
   Settings page can do. `test/settings-search.test.ts` already proves each entry points to a
   rendered anchor, while `test/settings-sidebar-render.test.ts` proves every category is rendered.
   Mandatory backup coverage metadata belongs on this registry. Persona, Session Action, Command,
   and Workflow catalogs are Library surfaces rather than Settings controls, so backup domain
   descriptors must distinguish `settings` from `library`; reverse control coverage applies only to
   the former, while both surfaces remain mandatory snapshot domains.

4. **All relational configuration shares one `WorkflowStore`, but its public writes are CAS
   operations with separate transactions.** `PersonaManager`, `SessionActionManager`,
   `WorkflowCommandManager`, and `WorkflowManager` share `personas.store` in production.
   `WorkflowStore.transact()` already exists for a caller that must commit more than one owner on
   the same SQLite handle. Restore needs one new store-owned bulk adapter that assumes this outer
   transaction, advances revisions above stored high-water marks, and never invokes the ordinary
   nested CAS methods.

5. **Immutable workflow versions and operational references prohibit row replacement.**
   `workflow_bindings` and `workflow_runs` keep version ids that must continue resolving. Restore
   may insert an exact missing historical version, but may never delete or rewrite a version.
   Conflicts on version id, `(workflow_id, version)`, or `(workflow_id, source_draft_revision)` fail
   preflight. A current unpublished workflow can have reused the normalized name of an older deleted
   workflow, and the unique index reserves archived names. That identity collision also fails
   preflight; silently renaming either workflow would change operator configuration.

6. **The daemon lifecycle already has the required timer and ownership patterns.**
   `startScheduleManager` and the task-source sweeper use non-overlapping, self-rescheduling,
   unreferenced timeouts with stop closures. `src/server/index.ts` starts durable recovery only after
   the loopback port bind and stops loops during shutdown. Daily backup belongs at the same boundary.
   The backup root is `join(STATE_DIR, "backups", "settings")`; it must not resolve the home again.

7. **Restore has external and live projections outside SQLite.** Skills reconciles symlinks and
   Cost edits Claude's settings file. Persona, action, Command, and workflow catalogs are cached by
   `Registry`; pipeline and settings status have their own projections. The durable transaction is
   followed by idempotent reconciliation. Known external blockers are checked before the safety
   snapshot; an unexpected post-commit failure becomes a warning and is retried from persisted
   intent at startup.

8. **`buildApp` is positional and broadly constructed by focused tests.** Any backup service route
   dependency is appended last and optional, with a 503 response when absent. The service itself is
   constructed once in `src/server/index.ts`; routes must never construct a second filesystem owner.

9. **A restore event is a shared contract change.** Adding `settings_restored` requires the
   exhaustive `useEventStream` case and an explicit decision for `LINE_INPUT_EVENTS`. It is not a
   Line input because it carries invalidation, not a bounded Line store. The initiating tab uses a
   client-generated request id to suppress its own notice and reload after success; other windows
   show a persistent Reload now notice so unsaved Library drafts are not discarded.

10. **The UI requires browser-level proof.** The repository requires a Playwright spec for every
    visible change, selected by role, label, or placeholder and using only fake agents. The restore
    spec must also seed SQLite through `withDaemonDb`, not a direct `DatabaseSync`.

## Decisions introduced by repository reconciliation

These decisions resolve implementation details the source plan could not safely infer. They do not
change the approved product behavior.

- Mixed config objects use exhaustive field classification. Restore merges only setting fields over
  the current parsed value, preserving Skills watermarks and current away state.
- Backup domains declare `surface: "settings" | "library"`. A Settings-surface domain must be
  referenced by at least one `SETTINGS_CONTROLS` entry. A Library domain must be present in the
  relational snapshot registry and is not forced to invent a Settings control.
- Relational identity or immutable-version uniqueness conflicts fail before the safety snapshot.
  Restore never renames operator rows to manufacture room for an older identity.
- Phase 2 lands the restore engine without a public route. This keeps the high-risk transaction
  independently testable while Phase 1's complete daily backups remain the only shipped behavior.
  Phase 3 exposes list, preview, and restore together with live browser invalidation and the Restore
  page, so no public mutation can leave a dashboard silently stale.
- The app version reader currently private to `routes.ts` moves to a small server helper in Phase 1
  so routes and snapshot metadata share one answer.

## Sizing and phase-count rationale

**Estimate: 2,800 to 4,200 gross non-test implementation lines added or materially changed.**

Assumptions behind the range:

- 900 to 1,400 lines for typed config and domain registries, logical capture, canonical envelope,
  secure atomic store, retention, and the daily lifecycle;
- 1,100 to 1,700 lines for relational preflight and forward restore, migrations, preview, safety
  snapshots, transaction coordination, and post-commit reconciliation;
- 800 to 1,100 lines for routes, event invalidation, Restore panel, cross-window notice, API client,
  and styles.

Tests, fixtures, and documentation are excluded. The estimate is intentionally gross because the
relational restore adapter may replace or reuse more of `WorkflowStore` after implementation-level
inspection.

Three phases are warranted:

- **Why Phase 1 and Phase 2 are not combined:** automatic capture and secure file retention are a
  complete recovery asset on their own. Relational rollback adds a separate corruption and history
  preservation problem across six tables and four uniqueness contracts. Combining them would make
  the first review responsible for both format publication and the most dangerous mutation in the
  feature, which weakens reviewability and makes failures harder to localize.
- **Why Phase 2 and Phase 3 are not combined:** the restore engine owns all-or-nothing persistence,
  revision monotonicity, immutable history, and external reconciliation. The final phase owns HTTP,
  cross-window browser behavior, a new Settings category, accessibility, responsive layout, and an
  end-to-end user flow. Either half is already a substantial test matrix. Phase 2 stays dormant
  until Phase 3 exposes it, so the split creates no unsafe public surface.
- **Why the final UI is not split further:** routes, the `settings_restored` event, browser
  coordination, and the Restore panel form one vertical slice. Landing any one without the others
  would create a dead control or a public restore that leaves clients stale.

## Phases

| # | Phase | File | Direct prerequisites | Repository |
| --- | --- | --- | --- | --- |
| 1 | Automatic logical snapshots | [`phase-1-automatic-logical-snapshots.md`](phase-1-automatic-logical-snapshots.md) | None beyond this planning session | This repository only |
| 2 | Transactional forward restore engine | [`phase-2-transactional-forward-restore.md`](phase-2-transactional-forward-restore.md) | Phase 1 | This repository only |
| 3 | Restore Settings experience | [`phase-3-restore-settings-experience.md`](phase-3-restore-settings-experience.md) | Phase 2 | This repository only |

## Dependency graph

```mermaid
flowchart LR
  PLAN[Planning PR publishes all plan files] --> P1[Phase 1: automatic logical snapshots]
  P1 --> P2[Phase 2: transactional forward restore]
  P2 --> P3[Phase 3: Restore Settings experience]
```

The graph is intentionally serial. Phase 2 consumes Phase 1's published envelope, domain ids,
config descriptors, file store, and service. Phase 3 consumes Phase 2's preview and restore result
contracts. No phases may execute concurrently.

## Merge order and publication gate

1. This planning pull request merges first and publishes every path named by the scheduled tasks.
2. Phase 1 merges before Phase 2 starts.
3. Phase 2 merges before Phase 3 starts.

Every phase task also depends directly on this planning session. The direct phase edges above are
additional gates, not replacements for the publication gate.

## Cross-phase contracts

- **Format ownership:** Phase 1 owns snapshot format v1, stable domain ids, filename shapes,
  canonical digest bytes, bounds, and the 90 plus 10 retention policy. Later phases may add readers
  and migrations but may not silently reinterpret a published v1 field.
- **Coverage ownership:** Phase 1 owns `APP_CONFIG_ENTRIES`, field classifications,
  `SettingsBackupDomainId`, Settings control coverage metadata, and coverage tests. Later phases
  consume these registries and must not create parallel inclusion lists.
- **Transaction ownership:** Phase 2 owns restore preflight, migration, preview semantics, the one
  SQLite transaction, revision advancement, immutable version preservation, safety snapshots, and
  post-commit reconciliation. Phase 3 never writes configuration directly.
- **Exposure ownership:** Phase 3 alone exposes the daemon engine through loopback routes and the
  dashboard. It owns request-id coordination, `settings_restored`, the other-window notice, and the
  Restore category.
- **No history rollback:** every phase excludes tasks, sessions, schedules, bindings, runs,
  submissions, attempts, reviews, usage, pipeline projections, leases, and ledgers.
- **No second writer:** all database and backup writes remain in the daemon. Browser and Foreman
  code use HTTP only.
- **Test isolation:** Node tests use `test/setup-state.mjs`; Playwright uses its isolated daemon,
  fake agents, and `withDaemonDb` for fixture database access.

## Final verification strategy

Each phase runs its focused tests plus `npm run typecheck`, `npm run lint`, and `npm test`. Phase 1
and Phase 3 also run `npm run build` and `npm run smoke` because they alter daemon lifecycle or the
built browser surface. Phase 3 runs the focused Restore Playwright spec followed by
`npm run test:e2e`.

The final end-to-end proof covers daily creation, list and preview, explicit confirmation, the
pre-restore safety snapshot, restored UI and Library configuration, preserved task and workflow-run
history, incompatible and corrupt files, post-commit warnings, and two-window reload behavior.
Evidence screenshots and command transcripts stay in gitignored artifacts and attach to the pull
request; they are never committed.

## Cross-phase audit record

- **2026-08-24, initial decomposition.** All source-plan requirements and submitted decisions are
  assigned exactly once. Phase 1 owns complete automatic backup, retention, and the automatic-or-red
  invariant. Phase 2 owns every restore safety and compatibility rule. Phase 3 owns the requested
  Settings menu, explicit confirmation, live client behavior, and browser proof. The phases are
  serial because each consumes stable contracts from its predecessor. Repository reconciliation
  added exhaustive field classification and preflight refusal for identity collisions; both close
  silent data-loss paths without changing the approved choices.
- **2026-08-24, final reconciliation.** Reread the root plan and all execution documents after Phase
  3 was complete. Every source requirement has one primary owner: Phase 1 for capture and coverage,
  Phase 2 for safe forward restore, and Phase 3 for exposure and browser behavior. Direct
  dependencies remain strictly serial, all three tasks also retain the planning-session publication
  gate, and no additional open product choice was introduced.
