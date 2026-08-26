# Phase 3 - First-run banner and the guided tour

Part of [`phased-plan.md`](phased-plan.md). Approved goal: [`plan.md`](plan.md).

## Outcome

A new operator is told their machine needs attention instead of having to find the Setup page,
and can be walked through it. A banner appears when any required row is not satisfied or on first
launch, dismisses durably, and returns if a required row later stops being satisfied. A `setup`
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
   this phase touches `SetupPanel.tsx` twice: attaching refs to the family sections Phase 1 gave
   stable ids, and taking the checks state as props once the hook is hoisted (step 1). Neither
   reaches into the remedy action slot Phase 2 edits, so the two remain mergeable in either order -
   but the hoist does change the panel's prop signature, so whichever of the two merges second
   rebases through a mechanical prop-wiring change. Phase 1 keeps that state and its `recheck`
   prop-passable precisely so this is a move rather than a rewrite.

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
- The banner shows when **either**: any `required` **row** is not satisfied, **or** no dismissal
  has ever been recorded (the first-launch case, so a fully-provisioned machine still gets told
  the page exists once).

  **Rows, not dependencies, and this distinction is the whole condition.** Phase 1 puts every row
  in one `SetupChecksView.rows` list from three sources, and two of the levels that matter most
  are not on a dependency at all:
  - the **derived terminal pair row** is the `required` one in the Terminals family, while every
    individual backend is `optional`. A machine with tmux and no emulator cannot open a terminal
    window, and a condition written over required *dependencies* would find nothing wrong with
    it - which is precisely the operator who most needs to be sent to Setup.
  - a folded **environment-check** row is `required` if its `ENVIRONMENT_ROW_METADATA` says so.

  So: iterate `rows`, keep `requirement === "required"`, and raise on status `missing` **or**
  `needs-setup`. `needs-setup` is in deliberately - a required-but-unauthenticated `gh` is the
  case that breaks an operator's first push, and it is never `missing`. `unknown` is deliberately
  **out**: "we could not look" is not evidence of breakage, and a banner that nags on it is both
  unactionable and unfixable by the operator.
- Dismissal is durable. **The banner returns if a `required` row later stops being satisfied**
  even after a dismissal - that is a machine that broke, not a preference the operator expressed.
  Store the dismissal so this is expressible: record what was dismissed (the first-launch notice,
  or a set of row ids), not merely a boolean, or the return case cannot be told from the dismissed
  one. Row ids are `SetupRowId`s, so serialize the discriminant with the id - a bare `"tmux"` and
  a bare `"terminal-pair"` come from different spaces and must not be able to alias.
- **Hoist the checks read to App - it is not there yet.** Phase 1 deliberately owns
  `useSetupChecks` inside `SetupPanel`, because at that point the panel is its only consumer
  (the rule `useSkills` and `useHarnesses` follow). The banner is the second consumer and it must
  evaluate before Settings is ever opened, so this phase moves the hook up to App and passes its
  state to both the banner and, through `SettingsPage`, to `SetupPanel` - which is exactly the
  distinction `useHarnesses`' own comment draws about Foreman, whose state the topbar shares.
  One owner, one read, two readers.

  This is a planned move rather than a violation of Phase 1: Phase 1's handoff names the hook as
  panel-local *until a second consumer exists*. Do not leave a second `useSetupChecks` mounted in
  the panel after hoisting, and do not add a poll - one mount read plus the explicit re-check is
  still the whole contract.

### 2. The banner component

`src/web/components/SetupBanner.tsx`, in `UpdateBanner`'s shape: one sentence naming how many
rows need attention, a link that navigates to `#/settings/setup`, and a dismiss control with an
accessible name. No modal, no blocking, no auto-navigation.

**Renders nothing until the first read lands.** Before the checks answer, "no required row is
missing" has not been established - it is unknown - and a banner that flashed on every load while
the read was in flight would train the operator to dismiss it unread.

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
  required row stops being satisfied after a dismissal**; stays hidden when only an `optional` row
  is missing; and behaves sanely when the checks read has not landed yet (unknown is not
  "everything is fine"). Three cases exist specifically because the row model has three sources,
  and a condition written over dependencies alone passes the first and fails the rest:
  - **the derived pair row missing** while every terminal backend is `optional` and present-ish
    (tmux installed, no emulator) - this must raise the banner;
  - a **required dependency in `needs-setup`** (`gh` present, not authenticated) - must raise;
  - a **required row in `unknown`** - must NOT raise.
- `test/app-config-entries.test.ts` (or the existing equivalent) - the new entry is declared with
  the intended classification and backup domain.
- The tour registration tests that already exist for the two shipped tours, extended to the new
  one: every declared target is registered by a rendered owner, every stage's content stop exists
  in the generated content, and the entry is reachable from both discovery surfaces. Confirm
  `npm run tours` output is committed and identical to a fresh run - a stale generated file is a
  failing check, not a cosmetic drift.
- `e2e/specs/setup-banner-and-tour.spec.ts` - the banner appears on a fresh daemon whose overrides
  make a required row unsatisfied, links to the Setup category, dismisses, stays dismissed
  across a reload, and re-appears when a required row stops being satisfied afterwards. Then the
  tour: start it from the Settings rail, walk at least two stops, and confirm it spotlights the
  panel and writes nothing. Selectors by role and label; no `data-testid`.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.
- Docs: `docs/setup.md` gains the banner and tour; `docs/ui.md` notes the banner; the tours
  documentation (`tours/README.md` and whatever `docs/` indexes tours) gains the new tour.

## Merge and exit criteria

- On a machine with a required row unsatisfied - including the tmux-without-an-emulator case,
  where the unsatisfied row is the derived pair rather than any dependency - the banner appears,
  links through, dismisses durably, and returns when a required row stops being satisfied again.
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
- **Inspector round 4 (major, PR #800).** The condition was written over required *dependencies*,
  which cannot see the derived terminal pair row - the only `required` row in the Terminals family,
  since the individual backends are `optional`. A machine with tmux and no emulator would never
  have been sent to Setup. Rewritten over required **rows** from Phase 1's single `rows` list, and
  while fixing it found the same bug in a second instance the review did not name: the condition
  raised only on `missing`, so a required-but-unauthenticated `gh` (always `needs-setup`, never
  `missing`) was equally invisible. Both now raise; `unknown` deliberately does not, with the
  reason recorded. Dismissal records now serialize the row id's discriminant so ids from different
  spaces cannot alias.
- **Inspector round 2 (major, PR #800).** This phase said the banner reuses a read "App already
  has a place to hold", but Phase 1 makes `useSetupChecks` panel-local, so no such read exists and
  the instruction was unimplementable both ways: reusing the panel hook leaves the banner unable to
  evaluate before Settings is opened, and adding a read violates the single-fetch rule. Resolved by
  making the hoist to App explicit here, and by amending Phase 1's handoff to say the hook is
  panel-local only until a second consumer exists. Also specified that the banner renders nothing
  until the first read lands, since "not yet known" is not "nothing is wrong".
