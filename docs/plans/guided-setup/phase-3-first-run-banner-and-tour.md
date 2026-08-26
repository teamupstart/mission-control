# Phase 3 - First-run banner and the guided tour

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

A new operator is told their machine needs attention instead of having to find the Setup page,
and can be walked through it. A banner appears when a required dependency is missing or on first
launch, dismisses durably, and returns if a required dependency later goes missing. A `setup`
tour narrates the panel from the Settings rail and the command palette.

## Entry criteria and dependencies

**Direct prerequisite: Phase 1.** Needs `GET /api/setup/checks` for the banner's condition, the
`setup` Settings category to link to, and the `setup-family-<id>` sections to spotlight.

Independent of Phase 2. May merge before or after it.

## Scope

- The dismissible first-run banner and its durable dismissal flag.
- The `setup` tour: authored copy, generated content, stage definitions, entry, target namespace,
  and the target refs the panel registers.
- Unit tests, an e2e spec, and the docs updates for both.

### Non-goals

- **No first-run wizard.** Decided: panel plus banner plus tour. The banner links to the panel;
  it does not become a second renderer of the catalog.
- **No new detection, no new probe, no catalog change, no route change** beyond the config entry
  the dismissal needs.
- **No rail dot** (Phase 1's finding 7 stands).
- **No hand-editing of `content.generated.ts`.**

## Repository findings this phase must honor

1. **Tour content is generated, and the generator is the only way to write it.**
   `src/web/tour/content.generated.ts` carries "GENERATED FILE - do not edit by hand", is written
   by `scripts/tour-content.ts` from `tours/*.md`, and is regenerated with `npm run tours`. Author
   `tours/setup.md` with the same `<!-- stage: <name> -->` convention the two shipped documents
   use, then run the generator and commit its output. Hand-editing generated files is a
   repository boundary, not a preference.

2. **A tour is five registrations, not one file.** `TourId` is a hand-written union
   (`src/web/tour/contracts.ts:10`, currently `"see-work" | "library"`); the stage file lives in
   `src/web/tour/tours/` (the two shipped ones are 335 and 415 lines); `TourEntry` in
   `tour/entries.ts` supplies the Settings rail row and the palette row; `TOUR_TARGET_NAMESPACES`
   in `tour/target-registry.ts` declares each semantic target and its scope. Every target here is
   `page` scope - the Setup panel is ordinary chrome, rendered once, with no per-task or per-run
   owner.

3. **Targets are registered by the components they spotlight**, through the target ref hook, so
   this phase does touch `SetupPanel.tsx` - attaching refs to the family sections Phase 1 gave
   stable ids. That is the seam; it does not overlap Phase 2's remedy action slot.

4. **`app_config` entries are declared, not ad hoc.** `src/shared/app-config-entries.ts` holds a
   schema, a `snapshotVersion`, a `capture` kind, a value classification, and a backup domain per
   key. The dismissal flag is an `operational` value, not a `setting`: it records what this
   operator has already seen, and restoring it from someone else's settings backup would
   resurrect or suppress a banner about a different machine. Choose `backupDomain: null`
   deliberately and say why in the entry's comment.

5. **Banner precedent.** `UpdateBanner.tsx` (114 lines) and `SettingsRestoredBanner.tsx` (29) are
   the register - App-level, dismissible, one job. Do not build a modal.

## Implementation steps

### 1. The dismissal flag and the banner condition

- Declare the `app_config` entry (`setup-banner-dismissed`, or the repository's naming
  convention) in `src/shared/app-config-entries.ts` with its schema and classification per
  finding 4, plus its read/write route wiring in the shape the neighbouring config entries use.
- The banner shows when **either**: any `required` dependency's status is `missing`, **or** no
  dismissal has ever been recorded (the first-launch case, so a fully-provisioned machine still
  gets told the page exists once).
- Dismissal is durable. **The banner returns if a `required` dependency later goes missing** even
  after a dismissal - that is a machine that broke, not a preference the operator expressed. Store
  the dismissal so this is expressible: record what was dismissed (the first-launch notice, or a
  set of ids), not merely a boolean, or the return case cannot be told from the dismissed one.
- Reuse the existing checks fetch. The banner must not add a second poll of
  `/api/setup/checks`; App already has a place to hold one read, and two consumers of one fetch
  is the rule the settings panels follow.

### 2. The banner component

`src/web/components/SetupBanner.tsx`, in `UpdateBanner`'s shape: one sentence naming how many
rows need attention, a link that navigates to `#/settings/setup`, and a dismiss control with an
accessible name. No modal, no blocking, no auto-navigation.

### 3. The tour

- `tours/setup.md` - the authored copy, one `## heading` plus `<!-- stage: … -->` per stop.
  Suggested stops: the panel itself, what a family is, what a status chip claims (and what
  `unknown` means), a remedy, the re-check button, and a close. Keep it to what the panel
  actually shows: the tour narrates, it does not promise behavior.
- `npm run tours` to regenerate `content.generated.ts`; commit the output, never hand-edit it.
- `TourId` gains `"setup"`; `tour/tours/setup.ts` defines the stages against the targets;
  `TOUR_TARGET_NAMESPACES.setup` declares each target as `page` scope; `tour/entries.ts` gains
  the entry with its Settings rail tooltip/heading/hint and its palette row, `entryRoute` pointing
  at the Setup category.
- `SetupPanel.tsx` attaches the target refs to the family sections.
- The tour writes nothing and installs nothing. If a stop wants to demonstrate a remedy, it
  points at the control and says what it would do; it does not click it.

## Tests and verification

- `test/setup-banner-condition.test.ts` - the condition as a pure function over
  (checks view, dismissal record): shows on first launch; hides after dismissal; **re-shows when a
  required row goes missing after a dismissal**; stays hidden when only an `optional` row is
  missing; and behaves sanely when the checks read has not landed yet (unknown is not "everything
  is fine").
- `test/app-config-entries.test.ts` (or the existing equivalent) - the new entry is declared with
  the intended classification and backup domain.
- The tour registration tests that already exist for the two shipped tours, extended to the new
  one: every declared target is registered by a rendered owner, every stage's content stop exists
  in the generated content, and the entry is reachable from both discovery surfaces. Confirm
  `npm run tours` output is committed and identical to a fresh run - a stale generated file is a
  failing check, not a cosmetic drift.
- `e2e/specs/setup-banner-and-tour.spec.ts` - the banner appears on a fresh daemon whose overrides
  make a required dependency missing, links to the Setup category, dismisses, stays dismissed
  across a reload, and re-appears when a required dependency goes missing afterwards. Then the
  tour: start it from the Settings rail, walk at least two stops, and confirm it spotlights the
  panel and writes nothing. Selectors by role and label; no `data-testid`.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.
- Docs: `docs/setup.md` gains the banner and tour; `docs/ui.md` notes the banner; the tours
  documentation (`tours/README.md` and whatever `docs/` indexes tours) gains the new tour.

## Merge and exit criteria

- On a machine with a required dependency missing, the banner appears, links through, dismisses
  durably, and returns when a required dependency goes missing again.
- The `setup` tour runs end to end from both the Settings rail and the command palette, writes
  nothing, and its generated content matches a fresh `npm run tours`.
- Full gate green.

## Downstream handoff

Last phase. Nothing depends on it. The banner's condition function and the dismissal record's
shape are the two things a future rail dot would reuse, if that decision is ever taken.

## Cross-phase audit record

- Reconciled against Phase 1: consumes `GET /api/setup/checks`, the `setup` category, and the
  `setup-family-<id>` sections; changes none of them. Confirmed the panel edit (target refs on
  section wrappers) does not touch the remedy action slot Phase 2 edits, so the two merge in
  either order.
- Reconciled against Phase 2: no dependency in either direction. The banner counts `required`
  rows that are `missing`, which is true whether or not the in-app install path exists.
- Changed the dismissal from a boolean to a record of what was dismissed during this write-up:
  a boolean cannot express "dismissed, then a required dependency went missing again", which the
  approved plan requires.
- Confirmed Phase 1's no-second-poll rule is inherited here: the banner reuses App's existing
  read of the checks route rather than adding its own.
