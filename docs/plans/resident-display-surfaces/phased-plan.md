# Resident drawer: phased implementation

Source plan: `docs/plans/resident-display-surfaces/plan.md`, managed plan
`3b3f339a-a7dd-4a62-9a3a-2890c71d2c4d`, the `plan.md` saved in the same revision as this index
(revision 10). The source plan is the requirement. This index and its phase files are the
proposed route.

## Incorporated human decisions

Submitted in dashboard review `5256ae0d-b872-4b85-a699-b47a73d50f91`:

- **Surface:** A, the slide-out drawer on the right, and no other surface.
- **Default:** the drawer, behind **Settings → Display → Residents → Where residents live**
  (**Drawer** | **Board and Console**), so a user can pick.
- **Needs you:** a visitor card, shown only while the drawer is closed.
- **Follow-up:** this phased plan.

## Repository findings that shape the phases

Verified at `c90f6287d`. `phase-1-resident-drawer.md` section 4 has file and line detail.

1. **No resident flag on a session.** Membership is `residentBySession.has(id)`, built in
   `src/web/App.tsx` from `residentMarksBySession` (`src/web/residents/marker.ts`).
2. **One choke point.** The `fleet` memo in `App.tsx` (search filter, then `orderSessions`) feeds:
   - the Board and Console rail
   - the arrow keys
   - the ⌘-numbers

   The placement predicate goes there. `fleet-order.ts` is the ordering function, not the filter
   site.
3. **The detail pane only opens sessions in that list.** **Decision:** one detail lookup reads the
   fleet list first and falls back to the open resident. The same detail component shows it, and
   the resident never joins the Board columns, the drill-in rail or the Console rail. App's
   selected-session actions read the same lookup.
4. **"Needs you" is the `attention` tone.** The top-bar count already covers all sessions,
   residents included.
5. **The dock's launch state is local.** **Decision:** lift it into one shared hook for the dock
   and the drawer.
6. **Placement is a server-persisted UI config field beside `layout`.** It touches `protocol.ts`,
   `app-config-entries.ts`, `uiCache.ts`, the route snapshot, settings search and the backup
   tests.
7. **Shortcuts match on `event.key`.** **Decision:** `⌥1`…`⌥9` match on `event.code`, are
   reserved from rebinding, and open resident N in both placements.
8. **`<Overlay>` is modal.** **Decision:** the floating drawer is a right-aligned `<Overlay>`, like
   Sitrep. The pinned drawer is a non-modal `<aside>` column.
9. **Existing resident e2e specs assume residents on the Board.** They must pin
   `residentPlacement: "fleet"`.
10. **Top-bar guards.** Drawer mode keeps the button element, the `residents-btn` class and the
    `Residents - N live` name.

## Sizing

**Estimate:** about 750 to 1,050 gross non-test lines.

- Phase 1, about 600 to 800:
  - UI config field and registries: 60
  - Placement predicate and App wiring: 120
  - Launch-state hook extraction: 60, mostly moved code
  - Drawer component, floating and pinned: 250 to 350
  - Drawer and visitor CSS: 120
  - ⌥N chords and Escape return: 60
  - Visitor card variant in Board and Console: 60
  - Inert-setting notes: 20
- Phase 2, about 150 to 250: latest message and open question preview, question option buttons,
  and the reply box, reusing existing composer and review-answer code.

Assumptions: the existing preview, composer and review-answer pieces are reused, not rewritten,
and the dock component stays as is for **Board and Console** mode.

**Phase count: two.** The total is well above 200 lines. Phase 1 is one vertical slice. Splitting
the setting, the predicate, the drawer and the visitor card across phases would leave either a
setting with nothing behind it or a default that hides blocked residents without a visitor card.
So they stay together. Phase 2 is a separate interaction surface: sending messages and answering
asks from inside the drawer. Its risk lies in messaging and review contracts that Phase 1 never
touches. Phase 1 is operable without it, because **Open** reaches the full conversation, where
replies and answers already work. Combining the two would put one pull request past about 1,000
lines across two unrelated contracts. Keeping them apart lets Phase 1's fleet-membership change
be reviewed on its own.

## Phases

| Phase | File | Outcome | Direct prerequisites |
|---|---|---|---|
| 1 | `phase-1-resident-drawer.md` | Placement setting (default Drawer), residents leave the fleet, slide-out and pinned drawer, open by click, Enter, ⌥N and the palette, visitor card while the drawer is closed | Planning session merge |
| 2 | `phase-2-drawer-quick-answers.md` | The drawer's selected card shows the latest message or open question, answers question options, and sends replies | Phase 1 |

**Dependency graph:** planning session, then Phase 1, then Phase 2. Nothing runs concurrently.
Phase 2 consumes Phase 1's drawer card contract.

**Merge order:** Phase 1, then Phase 2.

## Cross-phase contracts

Phase 1 owns these, and Phase 2 must not change them. The one exception is
`ResidentDrawerCardBody`, which exists for Phase 2 to add content inside.

- UI config fields `residentPlacement: "drawer" | "fleet"` (default `"drawer"`) and
  `residentDrawerPinned: boolean` (default `false`) in `src/shared/protocol.ts`.
- `src/web/lib/resident-placement.ts`, the single placement function. It returns the resident
  ids excluded from the fleet and the visitor ids, from the placement, `residentBySession`, the
  attention tone, and the drawer's open or pinned state.
- App's `detailSession` lookup: the fleet list first, then the open resident from all sessions.
  It is passed to `BoardView` and `ConsoleView` and read by the selected-session actions.
- `src/web/residents/useResidentLaunches.ts`, the one launch-state source for the dock and the
  drawer.
- `src/web/residents/ResidentsDrawer.tsx` and its card. The selected card's expanded body has a
  named region, `ResidentDrawerCardBody`, that Phase 2 fills. Phase 1 renders the tags and the
  Open, Run now and Pause / Resume actions there.
- App drawer state: open, pinned, the selected resident id, and the return target used by
  Escape, which is set only when a resident is opened from the floating drawer.
- The `alt+1`…`alt+9` reservation and the `code`-based matcher, active in both placements.

## Task map

Both phase tasks exist in the backlog. They were created after the artifact commit was pushed, so
do not create them again. Each depends on the planning session (task
`8f619c95-b452-4adc-8fbd-fdb1a6311aea`), so neither starts until this plan's pull request merges.

| Phase | Task id | Title | Agent / model | Direct dependencies |
|---|---|---|---|---|
| 1 | `660215f5-361a-47b0-b8d9-846b5497996c` | Resident drawer - Phase 1: Drawer placement and fleet exclusion | `claude` / `claude-opus-5-5` (UI) | planning session |
| 2 | `857d247c-2945-4c28-91f2-ca4a2af5ee5b` | Resident drawer - Phase 2: Quick answers in the drawer | `claude` / `claude-opus-5-5` (UI) | Phase 1 (`660215f5-361a-47b0-b8d9-846b5497996c`) and the planning session |

## Final verification strategy

- Phase 1 and Phase 2 each run their focused unit tests, `npm run typecheck`, `npm run lint`,
  `npm run build`, `npm run smoke`, and their Playwright specs under `npm run test:e2e`.
- After Phase 2, the source plan's acceptance criteria 1 to 9 are each covered by a spec or a
  unit test named in a phase file: criteria 1, 2, 4, 5, 6 and 7 in Phase 1, criterion 3 in
  Phase 2, criterion 8 in Phase 1, and criterion 9 across both.
- `docs/residents.md` and the `docs/ui.md` keyboard table match the shipped behavior after each
  phase.

## Final audit

- Every source-plan requirement has exactly one owner:
  - Placement setting, default and live switch: Phase 1.
  - Fleet exclusion: Phase 1.
  - Drawer, edge tab, pin and footer launch: Phase 1.
  - Open, Enter, ⌥N, palette and Escape return: Phase 1.
  - Visitor card: Phase 1.
  - Inert-setting notes: Phase 1.
  - Need you count, alerts and chime unchanged: Phase 1 verifies.
  - Latest message, question options and reply box: Phase 2.
  - Docs: each phase for its own behavior.
- Phase 2 consumes only Phase 1 contracts and adds no fleet-membership logic.
- The final state matches the source plan without undocumented cleanup.
- **Repair round 1 (Plan Validation run `28667a3b`):** an opened resident no longer joins any
  fleet list. The `detailSession` lookup replaces the earlier "admitted" rule, and Phase 1's
  steps, tests and exit criteria were updated to match. Phase 2 is unaffected.
- **Repair round 2:** `⌥1`…`⌥9` open resident N in both placements, consistently across the
  source plan, Phase 1 step 9 and its e2e coverage. Phase 2 is explicitly allowed to add content
  inside `ResidentDrawerCardBody` while keeping Phase 1's selection and opening behavior.
- **Repair round 3:** the index names the current source-plan revision. The source plan and
  Phase 1 now say exactly what stays unchanged in **Board and Console** (placement, markers,
  pinning and the dock), with `⌥1`…`⌥9` as its one addition.
- **Repair round 4:** Escape after opening a resident is defined separately for the floating
  drawer (reopen it, resident selected) and the pinned drawer (no return target, focus moves to
  the resident's card), in the source plan, Phase 1 steps 8 and 10, and its e2e coverage.
- **Repair round 5:** Phase 1 now describes opening a resident as layout-aware, matching the
  source plan: the Board drill-in in Board, the detail pane in Console. `openSessionOnFleet`
  already branches on layout (`App.tsx` around 1780). Phase 1 section 4, steps 8 and 9, and its
  e2e coverage say so.
- **Inspector review on PR #1382:** the task map now records the created task ids and their
  direct dependencies instead of instructions to create them.
