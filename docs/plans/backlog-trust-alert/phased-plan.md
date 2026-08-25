# Phased implementation plan: backlog repository-trust alert

## Source and approved direction

- Source plan: `docs/plans/backlog-trust-alert/plan.md`
- Rendered source: `docs/plans/backlog-trust-alert/plan.html`
- Submitted follow-up: **Create phased implementation plan**
- Product direction already fixed by the source plan: a persistent amber task-local notice in the
  existing backlog error-notification position on Board, Backlog drawer, and Sitrep; missing
  repositories named from the existing Foreman allowlist; manual launch preserved; **Manage trust**
  deep-links to the existing Trust matrix; no new endpoint, persisted state, desktop notification,
  or automatic grant.

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
4. The existing passive notification spot is persisted `task.error`, not `DeadBlockerButton`.
   Board renders it as `.bl-recovery` with attention color and `role="status"`; Sitrep mirrors it
   before dependency copy; the dispatch restart E2E spec proves the Board behavior. The Backlog
   drawer currently omits it and must complete the pattern without changing fixed row geometry.
5. `DeadBlockerButton` is an active stopped-prerequisite resolver. Its triangle, popover, and
   Reschedule/Mark done actions are deliberately out of scope for passive trust posture.
6. App already owns `openSettingsAnchor("trust", "trust/matrix")`. The Board can navigate
   directly; the drawer and Sitrep must close before invoking the same callback.
7. `src/web/lib/backlog-copy.ts` already owns cross-surface backlog words and the autopilot
   readout. The browser-only hold projection and copy belong there, not in wire contracts.
8. Existing tests provide direct templates: `e2e/specs/dispatch-restart-recovery.spec.ts` for the
   task status slot, `test/line-drawer.test.ts` and `test/line-drawer-electron.test.ts` for drawer
   behavior and geometry, and `e2e/specs/line-drawers.spec.ts` for real backlog interactions.

The repository disproved the original interaction assumption after human review: the existing
task-error status line is the correct reuse point, while the proposed dead-blocker triangle belongs
to a different active-remediation case. The source and phase artifacts now use one notice
precedence, with persisted `task.error` ahead of the derived trust posture. Worker liveness still
participates in eligibility so a dead worker does not produce a secondary repository explanation.

## Sizing and phase-count rationale

Estimated production-code change: **150–230 non-test lines**.

Assumptions:

- about 15–25 lines for the named shared allowlist projection and boolean refactor;
- about 30–50 lines for task-level eligibility and copy;
- about 25–45 lines for a shared notice model or presentation and inline Trust remedy;
- about 45–70 lines for App, prop, and three-surface wiring;
- about 35–55 lines for notice tone variants and fixed-height drawer placement.

Tests and documentation are excluded from this estimate. The work stays in **one phase** because it
is one compact vertical slice at or near the 200-line threshold, with no persistence or API
migration. A contract-only phase would merge an unused helper, while a UI-only phase would either
duplicate the scheduler's trust matcher or depend on unmerged code. One agent can implement and
verify the complete behavior safely.

## Phase table

| Phase | Outcome | Direct phase dependencies | Task |
|---|---|---|---|
| 1 | Reuse the task-error notification position for backlog trust notices across Board, Backlog drawer, and Sitrep | none | scheduled after plan artifacts are published |

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
- The UI derives notices from loaded task/config/status state and persists nothing.
- Parked rows stay silent, while persisted launch errors win the shared notice slot.
- Dependency marks may coexist with the trust notice.
- Trust remains the only grant editor; task surfaces only navigate to it.
- Notice precedence, copy, and attention styling are shared across all three task surfaces, using
  the existing task-error reading position rather than a new alert control.
- Manual dispatch and scheduler behavior remain unchanged.

## Phase index

- [Phase 1: Task-local trust warning](phase-1-task-local-trust-warning.md)

## Final verification strategy

Phase 1 owns all pure, render, browser, geometry, documentation, and build verification. The final
review should read the live scenario end to end:

1. seed a current worker lease and live, armed Foreman config with the task repository omitted;
2. prove each backlog surface exposes the same non-live notice and missing repository in the
   existing task-error position, while persisted recovery retains its status semantics;
3. prove dependency marks coexist, parked rows stay silent, and persisted errors win the slot;
4. use **Manage trust**, grant the repository through existing state, and observe every affected
   notice disappear after normal polling;
5. run typecheck, lint, unit and Electron tests, build, smoke, and Playwright with fake agents.

## Complete cross-phase audit

- Every source-plan requirement is owned by Phase 1 exactly once.
- No later phase is assumed to repair markup, styles, tests, docs, or navigation.
- No phase introduces a temporary API, schema, duplicated matcher, or dead UI surface.
- Human correction reconciled: the plan reuses the established task-error notification position
  and leaves the stopped-prerequisite popover unchanged.
- Accessibility reconciliation: derived trust posture is non-live even though it shares the visual
  position with transient recovery status.
- The one scheduled implementation task depends directly on the active planning session so its
  referenced paths cannot release before this plan reaches the default branch.
