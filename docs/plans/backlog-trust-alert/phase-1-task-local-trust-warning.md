# Phase 1: Task-local backlog trust warning

## Outcome

Deliver the full repository-trust explanation on every backlog task surface. When a running live
Foreman with armed autopilot cannot schedule an enabled, error-free task because one or more task
repositories are not allowlisted, the task uses the existing amber notification line beneath its
metadata. The notice names the missing repositories, preserves manual launch, and routes the
operator to the existing Trust matrix. A grant removes it through the normal Foreman config refresh.

This is the complete feature and the only implementation phase.

## Entry criteria and dependencies

- Direct phase dependencies: none.
- The planning session is a required task dependency. Its pull request must merge first so
  `plan.md`, `phased-plan.md`, and this file exist on the default branch.
- Start from an operable default branch and preserve unrelated work.

## Scope

- expose the exact missing primary/attached repository roots from the shared allowlist owner;
- derive the task-level trust hold from loaded Foreman and task state;
- reuse and complete the existing task-error notification placement with one accessible notice
  projection and attention-tone variant;
- render it on Board backlog cards, Backlog drawer rows, and Sitrep backlog rows;
- deep-link **Manage trust** to the existing Trust matrix;
- cover the policy, markup, browser interaction, geometry where affected, and documentation.

## Non-goals

- no scheduler policy or precedence change;
- no database, migration, endpoint, protocol, event, or task schema change;
- no automatic or one-click trust grant from the task;
- no queue-wide banner replacing the task-local notice;
- no toast, alert-center event, desktop notification, sound, or Away digest;
- no general server-owned vocabulary for every possible backlog hold;
- no visual redesign of the existing stopped-prerequisite alert.

## Repository findings and inherited contracts

### Scheduling and trust ownership

- `src/server/foreman/backlog-machine.ts:331-347` calls `taskReposAllowlisted` before it builds
  the ready set or checks capacity. The UI must use the same path matcher and all-repositories
  rule.
- `src/shared/allowlist.ts:20-52` is browser-safe and owns both path-boundary matching and the
  multi-repo AND. Do not reproduce `cwdAllowlisted` in React.
- The task's repository set is `task.repoRoot` followed by `task.extraRepos[].repoRoot`. Preserve
  that order in notice copy and report only uncovered roots.

### Existing browser state

- `App.tsx` holds the task list, `foreman.config`, and `foreman.status`. The status's `running`
  flag means a worker currently owns and renews the Foreman lease.
- `SessionViewProps` already includes `foremanEnabled`, `foremanMode`, and
  `foremanAllowlist` for layout consumers. Extend the existing state seam or replace those related
  fields with one coherent view only if every current consumer remains compatible.
- `BacklogDrawer` already receives `autoBacklog`, derived autopilot status, and whether Foreman is
  enabled/live. Do not add a second config fetch.

### Existing notification and navigation patterns

- `BacklogColumn.tsx:709-717` renders persisted `task.error` immediately beneath task metadata as
  `.bl-recovery` with `role="status"`. Its attention-colored, wrapping line is the existing Board
  notification spot for a launch that returned safely to Backlog.
- `ReportPanel.tsx:137-155` mirrors persisted task errors as a Sitrep backlog status line before
  dependency copy. Its current error-only style needs an attention variant for trust posture.
- `BacklogDrawer.tsx:188-240` does not currently render `task.error`. Complete the existing pattern
  by adding the notice to the row's identity stack while preserving its fixed-height contract.
- `e2e/specs/dispatch-restart-recovery.spec.ts:125-139` proves the Board notification spot with a
  real persisted recovery reason and semantic `getByRole("status")` assertion.
- `DeadBlockerButton` and `ChecksFailedIcon` solve a different case: an actionable stopped
  prerequisite. Do not extend their popover, triangle, or `.bl-deadblock-*` styles for trust.
- App's `openSettingsAnchor("trust", "trust/matrix")` is the remedy route. Trust remains the
  editor and confirmation owner.
- `repoLeaf` in `src/web/lib/format.ts` provides compact repository names. Canonical paths must
  remain available to disambiguate duplicate leaves.

### Eligibility contract

The task-local trust notice appears only after Foreman config/status load and when all are true:

- Foreman enabled;
- `mode === "live"`;
- worker `running`;
- `autoBacklog` on;
- task status `backlog`, `enabled`, `error === null`, and task kind permits autopilot;
- at least one task repository is not covered by `repoAllowlist`.

Suppress it for parked and launch-error tasks because those rows already carry a stronger local
explanation. Do not suppress it for dependencies: dependency completion cannot grant repository
trust, so both truths must remain visible.

## Implementation steps

### 1. Return missing repository roots from the shared matcher

In `src/shared/allowlist.ts`:

1. Add a named helper that accepts the same task shape and allowlist as
   `taskReposAllowlisted`, returning uncovered repository roots in task order.
2. Use `cwdAllowlisted` for each root, retaining exact, nested-root, and trailing-slash behavior.
3. Define `taskReposAllowlisted` from the missing list so boolean enforcement and named UI evidence
   cannot diverge.
4. Extend the focused allowlist or multi-repo policy tests. Include a task with an allowlisted
   primary and one untrusted attached repository.

Keep the helper browser-safe and free of `node:` imports.

### 2. Project the UI hold and own its copy once

In `src/web/lib/backlog-copy.ts`:

1. Define a compact nullable view-state input containing the loaded Foreman posture needed by the
   eligibility contract. Avoid exposing entire hooks or duplicating raw config objects in every
   component signature.
2. Add pure `backlogTrustHold` behavior that returns no hold or the ordered missing roots.
3. Use the shared task-kind capability and the new shared missing-root helper.
4. Add singular/plural copy helpers for the status sentence and compact inline remedy. The Board,
   drawer, and Sitrep must consume these rather than assembling their own sentences.
5. Keep browser words here and wire/policy primitives in `src/shared/`.

### 3. Reuse the task-notification slot

In `src/web/components/session-bits.tsx`:

1. Add a small `BacklogTaskNotice` presentation beside the other shared backlog leaves, or share a
   typed notice model if each host must retain its native row markup. Accept copy, tone, and an
   optional `onManageTrust` remedy without owning Foreman or task state.
2. Render the explanation as persistent inline text, not a triangle, popover, or live region. Use
   repository leaves in the visible sentence and canonical paths in tooltip or accessible text
   where needed.
3. State `Manual launch still works.` and offer a compact inline **Manage trust** action at the end
   of the same notice. Stop card click and drag propagation before routing.
4. Give derived trust copy no `role="status"` or `role="alert"`, and keep its action outside any
   live region. Persisted recovery copy alone retains its existing `role="status"`. Do not add
   `data-testid`, local dismissal, open state, outside-click handling, or Escape handling.
5. Resolve notice precedence once: persisted `task.error` wins, otherwise the trust hold appears,
   otherwise the slot is absent.

In `src/web/styles.css`:

1. Keep the Board notice in the current `.bl-recovery` position and preserve its small wrapping
   attention text. Generalize the class name only if that creates a clearer shared owner.
2. Generalize Sitrep's `.report-task-error` into danger and attention variants without moving the
   line.
3. Add a compact drawer notice line to `.line-bl-who`. Preserve `--line-drawer-row-h`, the exact
   three-row cap, ellipsis behavior, and legibility on dimmed parked rows.
4. Give the inline Trust action visible keyboard focus without making it read like a second launch
   button. Preserve `DeadBlockerButton` and its danger styles unchanged.

### 4. Wire Board, drawer, and Sitrep from App-owned state

In `App.tsx`:

1. Assemble the nullable backlog trust view from `foreman.config` and `foreman.status` once.
2. Define or reuse one callback that calls `openSettingsAnchor("trust", "trust/matrix")`.
3. Pass the view and remedy through the existing layout props to Board, and directly to
   `BacklogDrawer` and `ReportPanel`.
4. When the callback originates in the drawer or Sitrep, close that surface before navigating.

In `src/web/components/layouts/types.ts`, `BoardView.tsx`, and `BacklogColumn.tsx`:

1. Extend the existing Foreman/layout seam without adding fetches.
2. Compute the hold for each displayed backlog task, apply shared notice precedence, and render the
   result in the existing notification slot beneath metadata.
3. Let dependency marks and the trust status coexist. Keep parked tasks silent and let persisted
   errors replace trust through the projection, not hand-written JSX guards.

In `src/web/components/line/BacklogDrawer.tsx` and `src/web/components/ReportPanel.tsx`:

1. Accept the same view and remedy callback.
2. Compute the same hold per row and render the same notice projection in each surface's existing
   task-status position. The drawer gains the missing persisted-error/trust line.
3. Preserve existing row bands, header counts, launch buttons, switches, dead-blocker behavior, and
   drawer/Sitrep close semantics.

Do not store notice state in a task row or locally remove notices after navigation. The next
`useForeman` poll is authoritative and naturally removes all notices covered by a new grant.

### 5. Documentation

- Add the visible behavior to `README.md` near Backlog details and launch recovery.
- Add a repository-trust notice section near parked and stopped dependencies in
  `docs/dispatch-and-backlog.md`, naming all three surfaces, the multi-repo all-grants rule,
  manual launch, and **Manage trust**.
- Update the Backlog drawer row description in `docs/ui.md`.
- Review `docs/foreman.md` and update only wording that would otherwise contradict the new visible
  state. Do not duplicate the detailed UI contract there.

## Data, API, migration, and compatibility

- Data sources stay unchanged: tasks from snapshot/SSE and Foreman config/status from existing
  polling.
- The Trust action is client-side navigation to an existing route and anchor.
- There is no write from the alert itself. Grant writes remain owned by `TrustPanel` and its
  existing Foreman config patch.
- No database or migration work exists.
- No shared protocol shape changes, so older browsers and daemons have no mixed-version wire
  compatibility concern. An unloaded config/status fails closed by rendering no task warning.
- The shared boolean allowlist API remains available with identical semantics because it is defined
  from the new missing-root helper.

## Tests and verification

### Focused pure and render coverage

Add focused test files or extend the nearest owned suites to prove:

- unloaded config/status, off, non-live, worker-down, and autopilot-off suppress;
- an enabled, error-free eligible task in an untrusted primary repo warns;
- exact/nested/trailing-slash allowlist coverage suppresses;
- a multi-repo task reports only missing attached roots and remains blocked until all are covered;
- parked and launch-error tasks suppress;
- a dependency does not suppress;
- Board, Backlog drawer, and Sitrep contain the same projected notice in their task-status slot;
- singular/plural status copy and repository order are stable;
- persisted `task.error` wins the slot and remains visible on all three surfaces;
- derived trust notices use no live-region role, while persisted recovery notices retain
  `role="status"` and no notice uses `role="alert"`;
- trust uses attention styling while persisted errors retain each host's existing tone and stopped
  dependencies retain their danger styling.

Run focused files with the required preload, for example:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/backlog-trust-alert.test.ts test/backlog-trust-alert-render.test.ts
```

### Playwright

Add or extend an e2e spec using semantic selectors only:

1. Seed a Foreman heartbeat and configure Foreman enabled/live with autopilot on and an allowlist
   that omits the fixture task repository.
2. Seed a ready task and a dependent task. Confirm both notices exist while the dependent still
   says `after <task>`.
3. Exercise the inline notice on Board, Backlog drawer, and Sitrep. Assert non-live trust semantics,
   missing repository, manual-launch sentence, and Trust action; separately preserve the existing
   recovery status semantics.
4. Activate **Manage trust** and assert `#/settings/trust` plus the matrix anchor.
5. Grant or patch the repository through existing behavior, wait for the config poll, and prove the
   notices disappear without reload.
6. Seed parked and error cases and prove they retain only their existing explanations.
7. Capture gitignored visual evidence showing several Board notification lines and one Backlog
   drawer row using the same slot. Do not commit screenshots.

Use fake agents only. If the test manually launches a task to prove the escape hatch, assert the
fake session path and never invoke a real model.

### Geometry and full gates

- Extend `test/line-drawer-electron.test.ts` to prove the third identity line does not change row
  height, the three-row cap, or text overflow. A layout claim requires measured geometry.
- Run `npm run typecheck`.
- Run `npm run lint`.
- Run `npm test`.
- Run `npm run build`.
- Run `npm run smoke`.
- Run `npm run test:e2e`.
- Perform a runtime visual pass in both ordinary and narrow Board widths, checking wrapping,
  dimmed dependency cards, inline-action focus, fixed drawer rows, and dark/light themes.

## Merge and exit criteria

- All source-plan acceptance criteria pass on all three surfaces.
- Shared path matching remains the scheduler and UI source of truth, and the existing notification
  slot remains the single task-local explanation surface.
- The current `calendar-buddy` scenario shows four notices, with dependency marks retained on
  Phases 2–4.
- Granting Foreman access removes the notices after normal refresh.
- Parked/error tasks do not gain duplicate notices.
- Documentation matches the shipped interaction.
- Focused and full required gates pass, and visual evidence is attached to the pull request rather
  than committed.
- One reviewable pull request merges with no required later phase or cleanup.

## Downstream handoff

There is no later implementation phase. After merge, future backlog UI may rely on:

- the shared helper returning ordered missing repository roots;
- the browser projection that identifies this specific task-level hold;
- one projected task notice across the existing backlog notification positions;
- Trust remaining the sole grant editor.

Future work must not infer durable scheduler reasons from card text, persist dismissal state, or
bypass the all-repositories allowlist contract.

## Cross-phase audit record

- Initial audit: every source-plan requirement, documentation update, and verification layer is
  owned by this phase. There is no later phase to repair a partial UI.
- Human correction audit: repository tracing confirmed the existing task-error notification line
  is the reuse point. The discarded triangle popover belonged to stopped-prerequisite remediation,
  not passive scheduling posture. This phase now preserves that distinction and fills the drawer's
  existing task-error visibility gap.
- Accessibility reconciliation: trust reuses the line's visual position without inheriting
  `role="status"`; only transient persisted recovery remains a live region, and the Trust action is
  outside it.
- Compatibility audit: the new named helper preserves the existing boolean API, the feature uses
  already-shipped task/config/status data, and no consumer waits on a new server contract.
- Final audit: the one-phase graph has no concurrency or merge-order contradiction; its only
  prerequisite is publication of these plan artifacts by the planning session.
