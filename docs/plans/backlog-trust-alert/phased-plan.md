# Phased implementation plan: backlog repository-trust alert

## Source and approved direction

- Source plan: `docs/plans/backlog-trust-alert/plan.md`
- Rendered source: `docs/plans/backlog-trust-alert/plan.html`
- Submitted follow-up: **Create phased implementation plan**
- Product direction already fixed by the source plan: a persistent amber task-local warning on
  the Board, Backlog drawer, and Sitrep; missing repositories named from the existing Foreman
  allowlist; manual launch preserved; **Manage trust** deep-links to the existing Trust matrix;
  no new endpoint, persisted state, desktop notification, or automatic grant.

## Investigated findings

1. The scheduling refusal already has one shared server predicate. `decideBacklogTick` filters
   through `taskReposAllowlisted` before readiness and capacity, and
   `src/shared/allowlist.ts` is browser-safe. The missing list should be added there and the
   existing boolean should be defined from it.
2. The browser already holds every required input. Tasks arrive in App state through the snapshot
   and SSE, while `useForeman` polls config and status. `ForemanStatus.running` supplies worker
   liveness; config supplies `enabled`, `mode`, `autoBacklog`, and `repoAllowlist`.
3. `SessionViewProps` already threads `foremanEnabled`, `foremanMode`, and
   `foremanAllowlist` into layouts for session-level Foreman UI. The Board can extend that existing
   seam with autopilot and worker state rather than fetch anything itself.
4. `DeadBlockerButton` is already shared by the three backlog surfaces and establishes the exact
   tooltip, trigger, dialog, Escape, and outside-click pattern requested here.
5. App already owns `openSettingsAnchor("trust", "trust/matrix")`. The Board can navigate
   directly; the drawer and Sitrep must close before invoking the same callback.
6. `src/web/lib/backlog-copy.ts` already owns cross-surface backlog words and the autopilot
   readout. The browser-only hold projection and copy belong there, not in wire contracts.
7. Existing tests provide direct templates: `test/backlog-dead-blocker-render.test.ts` for shared
   alert markup, `test/line-drawer.test.ts` and `test/line-drawer-electron.test.ts` for drawer
   behavior and geometry, and `e2e/specs/line-drawers.spec.ts` for real backlog interactions.

No source-plan assumption was disproved. One implementation clarification is recorded: worker
liveness participates in the task alert, even though the source scheduler's repository filter is
independent of it. Without that UI gate, a dead Foreman worker could produce a true but secondary
repository warning while the primary reason nothing runs is that no worker is running.

## Sizing and phase-count rationale

Estimated production-code change: **220–320 non-test lines**.

Assumptions:

- about 15–25 lines for the named shared allowlist projection and boolean refactor;
- about 30–50 lines for task-level eligibility and copy;
- about 80–120 lines for the shared alert control and its interaction;
- about 45–70 lines for App, prop, and three-surface wiring;
- about 50–70 lines for grouped structural styles and the attention modifier.

Tests and documentation are excluded from this estimate. The work stays in **one phase** despite
slightly exceeding 200 lines because it is one compact vertical slice with no persistence or API
migration. A contract-only phase would merge an unused helper, while a UI-only phase would either
duplicate the scheduler's trust matcher or depend on unmerged code. One agent can implement and
verify the complete behavior safely, and one pull request is easier to review against the
source-plan acceptance criteria.

## Phase table

| Phase | Outcome | Direct phase dependencies | Task |
|---|---|---|---|
| 1 | Show and resolve task-local backlog trust warnings across Board, Backlog drawer, and Sitrep | none | scheduled after plan artifacts are published |

## Dependency graph and merge order

```text
Planning PR merges
        │
        ▼
Phase 1: backlog repository-trust alert
        │
        ▼
Feature complete
```

There are no concurrent implementation groups and no cross-repository merge unit. Phase 1 runs
only after the planning task completes, which publishes the paths its task prompt names. Its pull
request is the only feature merge.

## Cross-phase contracts

With one implementation phase, these are final compatibility contracts rather than handoffs:

- `src/shared/allowlist.ts` remains the only owner of path coverage and the all-repositories rule.
- The UI derives warnings from loaded task/config/status state and persists nothing.
- Parked and launch-error rows keep their existing single explanations.
- Dependency marks may coexist with the trust warning.
- Trust remains the only grant editor; task surfaces only navigate to it.
- The alert component, copy, and attention styling are shared across all three task surfaces.
- Manual dispatch and scheduler behavior remain unchanged.

## Phase index

- [Phase 1: Task-local trust warning](phase-1-task-local-trust-warning.md)

## Final verification strategy

Phase 1 owns all pure, render, browser, geometry, documentation, and build verification. The final
review should read the live scenario end to end:

1. seed a current worker lease and live, armed Foreman config with the task repository omitted;
2. prove each backlog surface exposes the same accessible warning and missing repository;
3. prove dependency marks coexist while parked/error rows do not acquire a duplicate warning;
4. open **Manage trust**, grant the repository through existing state, and observe every affected
   warning disappear after normal polling;
5. run typecheck, lint, unit and Electron tests, build, smoke, and Playwright with fake agents.

## Complete cross-phase audit

- Every source-plan requirement is owned by Phase 1 exactly once.
- No later phase is assumed to repair markup, styles, tests, docs, or navigation.
- No phase introduces a temporary API, schema, duplicated matcher, or dead UI surface.
- The one scheduled implementation task depends directly on the active planning session so its
  referenced paths cannot release before this plan reaches the default branch.
