# Phase 1: Task-local backlog trust warning

## Outcome

Deliver the full repository-trust explanation on every backlog task surface. When a running live
Foreman with armed autopilot cannot schedule an enabled, error-free task because one or more task
repositories are not allowlisted, the task carries an amber warning. The warning names the missing
repositories, preserves manual launch, and routes the operator to the existing Trust matrix. A
grant removes the warning through the normal Foreman config refresh.

This is the complete feature and the only implementation phase.

## Entry criteria and dependencies

- Direct phase dependencies: none.
- The planning session is a required task dependency. Its pull request must merge first so
  `plan.md`, `phased-plan.md`, and this file exist on the default branch.
- Start from an operable default branch and preserve unrelated work.

## Scope

- expose the exact missing primary/attached repository roots from the shared allowlist owner;
- derive the task-level trust hold from loaded Foreman and task state;
- add one shared, accessible warning control and attention-tone style;
- render it on Board backlog cards, Backlog drawer rows, and Sitrep backlog rows;
- deep-link **Manage trust** to the existing Trust matrix;
- cover the policy, markup, browser interaction, geometry where affected, and documentation.

## Non-goals

- no scheduler policy or precedence change;
- no database, migration, endpoint, protocol, event, or task schema change;
- no automatic or one-click trust grant from the task;
- no queue-wide banner replacing the task-local warning;
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
  that order in warning copy and report only uncovered roots.

### Existing browser state

- `App.tsx` holds the task list, `foreman.config`, and `foreman.status`. The status's `running`
  flag means a worker currently owns and renews the Foreman lease.
- `SessionViewProps` already includes `foremanEnabled`, `foremanMode`, and
  `foremanAllowlist` for layout consumers. Extend the existing state seam or replace those related
  fields with one coherent view only if every current consumer remains compatible.
- `BacklogDrawer` already receives `autoBacklog`, derived autopilot status, and whether Foreman is
  enabled/live. Do not add a second config fetch.

### Existing alert and navigation patterns

- `DeadBlockerButton` in `src/web/components/session-bits.tsx:2009-2147` is the interaction
  template and is already rendered by the Board, Backlog drawer, and Sitrep.
- `ChecksFailedIcon` is the established outlined triangle. Reuse the glyph, but use
  `--attention` rather than the dead-blocker's `--danger` tone.
- `src/web/styles.css:25172-25277` owns the current backlog alert geometry and host-specific width
  rules. Share structural styles or group selectors rather than copy a second complete popover.
- App's `openSettingsAnchor("trust", "trust/matrix")` is the remedy route. Trust remains the
  editor and confirmation owner.
- `repoLeaf` in `src/web/lib/format.ts` provides compact repository names. Canonical paths must
  remain available to disambiguate duplicate leaves.

### Eligibility contract

The task-local warning appears only after Foreman config/status load and when all are true:

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
4. Add singular/plural copy helpers for the tooltip, accessible name, and dialog lead. The Board,
   drawer, and Sitrep must consume these rather than assembling their own sentences.
5. Keep browser words here and wire/policy primitives in `src/shared/`.

### 3. Add the shared alert control

In `src/web/components/session-bits.tsx`:

1. Add `BacklogTrustAlert` beside `DeadBlockerButton` with props for task title, missing roots, and
   `onManageTrust`.
2. Reuse the warning triangle, Tooltip, outside-click dismissal, Escape dismissal, and labelled
   dialog pattern. Preserve focus on or return it to the trigger when the dialog closes.
3. Use repository leaves in the lead and canonical paths in the list or tooltips. Handle singular
   and plural copy without truncating the accessible name.
4. State `Manual launch still works.` and offer one **Manage trust** button. Close the dialog before
   invoking the navigation callback.
5. Do not add `role="alert"`, `data-testid`, or a local dismissed state.

In `src/web/styles.css`:

1. Share the dead-blocker popover's structural geometry through grouped selectors or a small common
   class.
2. Add a trust-specific attention modifier using existing tokens.
3. Keep the trigger icon-sized, keyboard focus visible, text contrast legible on dimmed dependency
   cards, and the popover within the Board card and drawer/Sitrep stacking rules.
4. Preserve the danger color and behavior of `DeadBlockerButton`.

### 4. Wire Board, drawer, and Sitrep from App-owned state

In `App.tsx`:

1. Assemble the nullable backlog trust view from `foreman.config` and `foreman.status` once.
2. Define or reuse one callback that calls `openSettingsAnchor("trust", "trust/matrix")`.
3. Pass the view and remedy through the existing layout props to Board, and directly to
   `BacklogDrawer` and `ReportPanel`.
4. When the callback originates in the drawer or Sitrep, close that surface before navigating.

In `src/web/components/layouts/types.ts`, `BoardView.tsx`, and `BacklogColumn.tsx`:

1. Extend the existing Foreman/layout seam without adding fetches.
2. Compute the hold for each displayed backlog task and render `BacklogTrustAlert` with its other
   scheduling marks.
3. Let dependency and trust marks coexist. Keep parked/error tasks silent through the projection,
   not hand-written JSX guards.

In `src/web/components/line/BacklogDrawer.tsx` and `src/web/components/ReportPanel.tsx`:

1. Accept the same view and remedy callback.
2. Compute the same hold per row and render the same shared alert control.
3. Preserve existing row bands, header counts, launch buttons, switches, dead-blocker behavior, and
   drawer/Sitrep close semantics.

Do not store alert state in a task row or locally remove warnings after navigation. The next
`useForeman` poll is authoritative and naturally removes all warnings covered by a new grant.

### 5. Documentation

- Add the visible behavior to `README.md` near Backlog details and launch recovery.
- Add a repository-trust warning section near parked and stopped dependencies in
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
- Board, Backlog drawer, and Sitrep contain the same shared alert markup;
- singular/plural accessible names and copy are stable;
- no persistent warning uses `role="alert"`;
- trust uses attention styling while stopped dependencies retain danger styling.

Run focused files with the required preload, for example:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/backlog-trust-alert.test.ts test/backlog-trust-alert-render.test.ts
```

### Playwright

Add or extend an e2e spec using semantic selectors only:

1. Seed a Foreman heartbeat and configure Foreman enabled/live with autopilot on and an allowlist
   that omits the fixture task repository.
2. Seed a ready task and a dependent task. Confirm both warnings exist while the dependent still
   says `after <task>`.
3. Exercise the shared warning on Board, Backlog drawer, and Sitrep. Assert the accessible name,
   missing repository, manual-launch sentence, and labelled dialog.
4. Activate **Manage trust** and assert `#/settings/trust` plus the matrix anchor.
5. Grant or patch the repository through existing behavior, wait for the config poll, and prove the
   warnings disappear without reload.
6. Seed parked and error cases and prove they retain only their existing explanations.
7. Capture gitignored visual evidence with several closed icons and one open dialog. Do not commit
   screenshots.

Use fake agents only. If the test manually launches a task to prove the escape hatch, assert the
fake session path and never invoke a real model.

### Geometry and full gates

- Extend `test/line-drawer-electron.test.ts` if the new trigger or shared structural styles change
  row height, cap, or popover overflow. A layout claim requires measured geometry.
- Run `npm run typecheck`.
- Run `npm run lint`.
- Run `npm test`.
- Run `npm run build`.
- Run `npm run smoke`.
- Run `npm run test:e2e`.
- Perform a runtime visual pass in both ordinary and narrow Board widths, checking dimmed dependency
  cards, popover stacking, focus, and dark/light themes.

## Merge and exit criteria

- All source-plan acceptance criteria pass on all three surfaces.
- Shared path matching remains the scheduler and UI source of truth.
- The current `calendar-buddy` scenario shows four warnings, with dependency marks retained on
  Phases 2–4.
- Granting Foreman access removes the warnings after normal refresh.
- Parked/error tasks do not gain duplicate alerts.
- Documentation matches the shipped interaction.
- Focused and full required gates pass, and visual evidence is attached to the pull request rather
  than committed.
- One reviewable pull request merges with no required later phase or cleanup.

## Downstream handoff

There is no later implementation phase. After merge, future backlog UI may rely on:

- the shared helper returning ordered missing repository roots;
- the browser projection that identifies this specific task-level hold;
- one shared accessible trust alert across all backlog surfaces;
- Trust remaining the sole grant editor.

Future work must not infer durable scheduler reasons from card text, persist dismissal state, or
bypass the all-repositories allowlist contract.

## Cross-phase audit record

- Initial audit: every source-plan requirement, documentation update, and verification layer is
  owned by this phase. There is no later phase to repair a partial UI.
- Compatibility audit: the new named helper preserves the existing boolean API, the feature uses
  already-shipped task/config/status data, and no consumer waits on a new server contract.
- Final audit: the one-phase graph has no concurrency or merge-order contradiction; its only
  prerequisite is publication of these plan artifacts by the planning session.
