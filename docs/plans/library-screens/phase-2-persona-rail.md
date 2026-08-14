# Phase 2: The Persona screen, and the rail grammar the others inherit

## Outcome

The Persona detail screen becomes the Rail direction: a rail that groups what ships from what you
wrote, a workspace with one promoted verb instead of four equal links, and metadata as property
chips that say what this Persona actually overrides. The shared primitives land here with their
first real consumer rather than as an unused kit.

## Entry conditions and dependencies

- **Depends on Phase 1**, merged and green. The back row and the Escape ladder are inherited, not
  rebuilt.
- Read [`plan.md`](plan.md), [`phased-plan.md`](phased-plan.md), and Phase 1's downstream handoff.
- Open [`mockups/personas.html`](mockups/personas.html), approach **A · Rail**. It is the approved
  visual target for this phase.
- Re-read `src/web/components/ContextMenu.tsx` and `src/web/components/Overlay.tsx` before building
  any menu or popover. Both exist; neither should be reinvented.

## Scope

### Included

- `PersonaLibrary` rail: Built-in / Yours groups with counts, runner and model sub-labels, search
  retained, import and archived-state moved to a rail footer;
- `PersonaEditor` header: one promoted verb plus an overflow menu;
- the property-chip row replacing the five-field metadata block, with inherited and overridden
  rendered differently;
- the guidance editor taking the remaining height;
- the shared primitives the next two phases consume, extracted only as far as those phases actually
  need;
- CSS, render tests, and a Playwright spec.

### Excluded

- the Actions and Commands screens (Phases 3 and 4);
- the "used by" footer (Phase 5). Leave the slot; ship no half-answer;
- any change to persona persistence, import, drift detection, provenance, or the conflict and
  archive flows. This phase rearranges their surface, not their behaviour;
- any change to what `filterPersonas` or `readPersonaImport` export or mean - `test/` imports both
  from `PersonaLibrary.tsx` directly.

## Repository findings and inherited contracts

1. **Two test files import helpers straight out of `PersonaLibrary.tsx`**:
   `test/workflow-builder-performance.test.ts` imports `filterPersonas`, and
   `test/seed-personas.test.ts` imports `readPersonaImport`. Moving either export breaks tests that
   have nothing to do with this redesign. Keep the export surface.
2. **`test/persona-editor-render.test.ts` is large and specific** - 24 cases pinning status-line
   precedence, built-in read-only behaviour, drift badges, byte-exact import and export, CRLF
   preservation, and that `Cmd/Ctrl+S` owns save without claiming a bare `S`. Expect to update its
   markup expectations; do not weaken its behavioural ones.
3. **`test/overlay-registry.test.ts` walks every `.tsx` under `src/web`** and asserts that only
   `Overlay.tsx` contains `modal-backdrop`, checking `role="dialog"` surfaces against a hard-coded
   allowlist. **The overflow menu and the chip popovers must not introduce either.** Use
   `ContextMenu`, or a plain menu with `role="menu"`, or route through `Overlay`.
4. **The status line has a defined precedence**: built-in, then archived, then the conflict banner,
   then unsaved changes, then drift. The chip row does not replace it and must not reorder it.
5. **Built-in personas can be shadowed by a same-named operator persona**
   (`personasForDisplay`); `test/builtin-personas-web.test.ts` pins the resolution. Grouping rows
   into Built-in and Yours must not change which row wins, only where it is drawn.
6. **The palette indexes personas by runner and model** (`test/palette-index.test.ts`). If the rail
   sub-label and the palette row drift apart, that is a second source of truth - reuse the shared
   helper rather than formatting the string twice.
7. Inherited from Phase 1: `LibraryBackRow` sits above the rail heading, `useLibraryEscape` owns
   Escape, and any new dismissible surface must not install a competing `window` listener.

## Implementation steps

1. Build the rail grouping in `PersonaLibrary.tsx`. Derive Built-in and Yours from the existing
   `builtin` flag, render a count on each group head, and keep the existing search and archived
   filtering semantics exactly as they are. Reuse the sticky group-head styling the console rail
   already has rather than inventing a heading.
2. Replace each row's description sub-label with the resolved runner and model, sourced from the
   same helper the palette row uses.
3. Move Import .md and the archived-state control into a rail footer beneath the list, leaving the
   heading, the New button and the search box as the only things above it.
4. Restructure the `PersonaEditor` header: name, built-in tag and provenance line on the left; the
   single promoted verb on the right - Save when the Persona is editable, Duplicate when it is
   built-in - with Copy Markdown, Download .md, Re-import from source and Archive behind an overflow
   menu. Keep every action's existing behaviour and disabled logic; only their placement changes.
5. Replace the five-field metadata block with the property-chip row: provider and model as
   interactive chips, effective source and guidance byte count as read-only chips. A chip whose
   value is inherited from app defaults renders quiet; a chip carrying an explicit override renders
   solid. The byte-count chip keeps its over-limit treatment.
6. Have each interactive chip open its existing control in a popover rather than replacing the
   control. The `select` elements and `ModelField`/`ModelSuggestions` keep their behaviour, validation
   and accessible names.
7. Let the guidance editor take the remaining height, with the Preview/Editor toggle unchanged.
8. Leave a footer slot below the editor for Phase 5, rendering nothing.
9. Extract only what Phases 3 and 4 will actually consume - the rail group head, the rail row, the
   property chip, and the workspace header - into shared modules under `src/web/library/`. Do not
   pre-generalise beyond those consumers.
10. Add the CSS in the existing authoring section of `src/web/styles.css`. The three surfaces already
    share the master-detail grid rules there; extend them rather than forking a second set.

## Compatibility

- No server, schema, route or persisted-identifier change.
- No change to the persona wire types or to `src/shared/`.
- Import, re-import, drift, conflict resolution and archive keep their current behaviour and their
  current accessible names, so `e2e/specs/persona-import-provenance.spec.ts` and
  `e2e/specs/copy-confirms-and-reports.spec.ts` keep passing. If either needs a selector change,
  prefer restoring the accessible name over editing the spec.

## Tests and verification

### Unit and render

- [ ] Update `test/persona-editor-render.test.ts` for the new markup, keeping every behavioural
      assertion it already makes.
- [ ] Add cases for the grouping: counts, ordering, a shadowed built-in landing in the right group,
      and the empty Yours group's copy.
- [ ] Add cases for chip state: inherited versus overridden rendering, and the over-limit byte count.
- [ ] `test/overlay-registry.test.ts`, `test/builtin-personas-web.test.ts`,
      `test/workflow-builder-performance.test.ts`, `test/seed-personas.test.ts` and
      `test/palette-index.test.ts` stay green without edits.

### Playwright, required

- [ ] The rail shows Built-in and Yours with counts, and a persona opens from each.
- [ ] The overflow menu reaches Copy Markdown, Download .md and Archive, and closes on Escape without
      leaving the page.
- [ ] A property chip opens its control, changes a value, and the change survives Save and reload.
- [ ] A built-in promotes Duplicate and offers no enabled Save.
- [ ] Phase 1's exit spec still passes unedited.

### Commands

```
npm run typecheck
npm run lint
npm test
npm run build && npm run test:e2e
```

## Merge and exit criteria

- [ ] The Persona screen matches approach A in the mockup at 1440 and at a narrow width.
- [ ] No persona behaviour changed: import, drift, conflict, archive and save all work as before.
- [ ] The full gate passes.
- [ ] Screenshots attached to the pull request from a gitignored location.

## Downstream handoff

Phases 3 and 4 consume the rail group head, the rail row, the property chip and the workspace header
from `src/web/library/`. They may extend those primitives with their own props; they must not fork
them, restyle them locally, or change the accessible names Phase 2's Playwright spec selects by.

Phase 5 fills the footer slot left below the editor. It is empty and renders nothing until then.

## Cross-phase audit record

- Reconciled with Phase 1: the back row and Escape ladder are inherited unchanged. Step 6's popovers
  and step 4's overflow menu are the first new dismissible surfaces on these screens, so Phase 1's
  handoff note about not installing competing `window` listeners is load-bearing here and is
  restated as finding 7.
- Reconciled with the source plan: the plan lists the "used by" footer under this screen. The
  repository finding recorded in `plan.md` moved it to Phase 5; this phase leaves only the slot.
- No earlier phase required editing.
