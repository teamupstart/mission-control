# Phase 2: Library Commands and workflow vocabulary

## Outcome

Make Library the clear, reusable home for workflow Commands. Add a question-led Commands shelf and
fixed-slot editor, remove command authoring from Workflow Settings, simplify authorization copy,
and change visible workflow terminology from Check to Command without changing serialized graphs or
runtime behavior.

## Entry conditions and dependencies

- Phase 1 is merged and its catalog, routes, `MissionState` collection, migration, compatibility
  adapter, and runtime resolver are green.
- Read the source plan, phased index, and Phase 1 handoff.
- Re-read `docs/library-and-line.md`, `e2e/README.md`, and the current Library route/model/editor CSS
  before editing.
- Verify the exact shared Command view and API names Phase 1 landed. Adapt this proposed component
  map to those names rather than creating aliases or parallel state.

## Scope

### Included

- sixth question-led Commands shelf with four fixed cards;
- `#/library/commands/<slot>` parse, serialize, navigation, and selection behavior;
- Library-native Command editor for global default and path overrides;
- exact argv parsing/preview using existing helpers;
- compare-and-swap save and visible conflict/error handling;
- workflow palette configuration state and Library deep link;
- visible Command terminology across authoring and run-detail surfaces;
- removal of command authoring from Workflow Settings;
- retained, simplified authorization control and Trust summary;
- settings search, command palette, accessible labels, documentation, render tests, and Playwright;
- visual/runtime verification using the built dashboard.

### Excluded

- any database, migration, resolver, policy, or execution-runtime change;
- user-created slots, New/archive/duplicate actions, suites, environment fields, or shell mode;
- direct execution from Library;
- a new Trust column or per-command confirmation;
- wholesale internal renaming of `check` types, files, CSS history, or durable diagnostics.

## Library shelf contract

Append `commands` to `LIBRARY_SHELVES` without reordering existing hash segments, and add it to the
authoring surface registry. The Library model remains the single pure source for shelf copy and card
facts.

Use this teaching shape unless existing typography requires a tiny copy adjustment:

- eyebrow: **Commands**;
- question: **What does each standard gate run?**;
- why: explain that workflows name portable slots while this catalog supplies global defaults and
  optional exceptions;
- glyph: choose one already harmonious with Library's mono glyph language rather than importing an
  icon package.

Cards:

- always render in `WORKFLOW_CHECK_SLOTS` order;
- use the slot string as stable asset id and visible name;
- describe the conventional gate in one sentence without claiming a specific package manager;
- carry a built-in tag because slots ship with the product and cannot be deleted;
- show only durable configuration facts, not run status;
- have no New card, archive, duplicate, or cross-link to a live list;
- open the corresponding editor through `onOpenAsset("commands", slot)`.

The per-shelf live/cross-link control currently required by `Shelf` may become an optional neutral
link or be generalized according to the existing component's semantics. Do not fake a run count or
link all Commands to an unrelated run page merely to satisfy a prop. If the component is widened,
keep all five existing shelves byte-equivalent in behavior and cover the optional case in render
tests.

Update Library's header to say that nothing **runs from here** and execution state remains on Runs
and Ensembles. This preserves the authoring/execution boundary while allowing executable
definitions to live in Library.

## Route and App integration

Extend the one hash router in `src/web/workflows/useWorkflowRoute.ts`:

- `commands` is a valid `LibrarySurface`;
- `#/library/commands` opens the surface with its normal default selection;
- `#/library/commands/test` selects `test`;
- an unknown or undecodable asset segment falls back to the surface's valid default, following the
  existing asset behavior;
- `new` is not a valid Command action. The route type should prevent a New affordance for this
  fixed catalog, or the surface must normalize it to its default without offering a blank draft;
- parsing and serialization round-trip in route tests and preserve all existing legacy routes.

Mount one Command surface in the existing `libraryBody` branch in `App.tsx`. Pass Phase 1's live
collection from `MissionState`; do not fetch a second list. Follow the per-shelf memoized selection
callback pattern so route replacement does not loop.

## Command editor

Build the editor from existing Library and workflow form primitives. It should look like it belongs
beside `PersonaLibrary`, `SessionActionLibrary`, and `WorkflowLibrary`, not like the Settings table
moved wholesale.

### Information architecture

- left rail: four slots, built-in status, and short configuration fact;
- editor header: selected slot, built-in badge, concise purpose, revision/save state;
- default section: one command line, clear/remove action, and exact argv preview;
- overrides section: current override rows plus an add/edit flow using `RepoCombobox`;
- save action: one atomic replacement of default plus overrides under the loaded revision;
- error/conflict state: visible sentence and re-adopt/retry behavior consistent with adjacent
  editors.

The editor manages a local draft. Switching slot or leaving the surface must use the existing dirty
draft navigation guard through `onDirtyChange`; it must not silently discard an unsaved command.
Adopt external SSE updates only when the draft is clean. If a changed revision arrives while dirty,
surface the conflict rather than overwriting typed work.

### Command fields

- Reuse `parseCheckCommand` and `formatCheckCommand`; do not introduce a shell parser.
- Store argv exactly as Phase 1's schema expects.
- Show the exact numbered or tokenized argv preview before save.
- A blank default means `null`; it does not create an empty argv.
- The default is explicitly labeled repository-neutral and should avoid copy like “for trusted
  repositories” that can be misread as automatic execution.
- Explain once that execution happens only when a workflow reaches the slot and the repository has
  the Workflows Trust grant.

### Override fields

- Reuse the shared repository list and `RepoCombobox`, including free text for subdirectories.
- Resolve/canonicalize the selected path through the same daemon API and `checkCommandRoot`
  semantics the old Settings editor uses.
- One `(slot, path)` row is one identity. Editing replaces it; duplicates never depend on array
  order.
- Show a readable repository name and enough path detail to distinguish nested package overrides.
- Sort or preserve order according to Phase 1's stable view contract; do not create a second
  resolution ordering in the browser.
- Removing an override changes the draft and persists only on Save, unless adjacent editors use an
  explicit immediate mutation pattern consistently. Whichever pattern is chosen must be clear and
  tested.

## Workflow authoring integration

Keep the palette's fixed slot selector and node creation mechanics, but use Command everywhere a
person sees the executable node:

- `+ Command` palette button;
- accessible name such as `Slot for new Command node`;
- graph/pipeline card label `Command · test`;
- properties heading/help text;
- duplicate-selection tooltip;
- ladder peek, validation messages, run detail, skipped/unavailable summaries, and status tooltips;
- Settings and Trust prose that refers to workflow Commands.

Do not globally replace the word “check.” Keep ordinary actions such as “Check upstream,” “Check it
works,” checkboxes, CI checks, and internal comments where they do not name this feature.

Use Phase 1's `MissionState` catalog in `WorkflowLibrary` to show the selected slot's durable status:

- global default available;
- overrides only;
- not configured.

Add a clear link or button to `#/library/commands/<slot>`. Do not prevent adding an unconfigured
slot: current portable workflows intentionally skip with a note on machines where a slot is absent.
The UI should state that behavior instead of converting it into a validation error.

Persisted creation still calls `addNode({ kind: "check", slot })`. Validation codes and published
graph bytes do not change.

## Settings relocation and safety copy

Remove the following from `WorkflowSettingsPanel.tsx`:

- repository/slot/command add row;
- stored command list and remove buttons;
- local command draft state, repository fetch, parser preview, and helper code used only by that
  table;
- the persistent warning banner that repeats the enable confirmation.

Keep:

- the machine-wide authorization/pause control, relabeled **Allow workflow Commands** or the
  clearest adjacent-console equivalent;
- one concise confirmation that Commands execute branch-authored code with daemon filesystem
  authority in repositories granted through Trust;
- the Workflows Trust summary and deep link;
- workflow health, Live delivery, default workflow, and retention controls.

Add a neutral link strip or sentence from Settings to `#/library/commands` so an operator searching
old terminology reaches the new home. Update `settings-search.ts` anchors and descriptions so
queries for command, check command, test, lint, typecheck, and build lead to the right destination
or authorization control. Do not leave an anchor pointing at removed markup.

Safety copy should be calm and exact:

- configuration alone does not run anything;
- the command runs later in a commit-pinned checkout when a workflow reaches it;
- execution uses argv without a shell;
- repository Trust and the authorization control still gate it;
- avoid repeating the same warning around each input or override.

## Styling and accessibility

- Extend the existing Library/editor and workflow CSS sections in `src/web/styles.css`.
- Reuse spacing, borders, mono labels, chips, buttons, form controls, narrow breakpoints, focus
  rings, and dirty/save states already used by neighboring surfaces.
- Do not introduce a component framework, icon package, isolated color palette, or generic card
  redesign.
- Preserve keyboard navigation and visible focus for slot list, command fields, override controls,
  save, and Library links.
- Use semantic buttons, labels, status regions, and accessible names. Do not add `data-testid`.
- Verify the split editor at normal and narrow dashboard widths, including long paths and argv.

## Documentation

Update at least:

- `docs/library-and-line.md` to describe six shelves, the Commands authoring/execution boundary,
  and the route;
- workflow configuration docs or README references that currently point to Settings command
  authoring;
- search/help copy that teaches where Commands live and how overrides resolve;
- any screenshot-free examples that call the visible node Check.

Keep internal protocol documentation honest that serialized nodes remain `check`. Do not rewrite
historical plan documents or generated changelog output.

## Implementation map

Re-verify and likely touch:

- `src/web/workflows/useWorkflowRoute.ts`
- `src/web/App.tsx`
- `src/web/library/library-model.ts`
- `src/web/library/LibraryPage.tsx`
- a focused `CommandLibrary`/editor component under the existing Library or workflows family
- `src/web/components/WorkflowSettingsPanel.tsx`
- `src/web/lib/settings-search.ts`
- `src/web/workflows/WorkflowLibrary.tsx`
- `src/web/workflows/WorkflowProperties.tsx`
- `src/web/workflows/pipeline-bits.tsx`
- `src/web/workflows/WorkflowLadderPeek.tsx`
- `src/web/workflows/WorkflowRuns.tsx`
- any shared visible label helper such as `workflowNodeLabel`
- `src/web/styles.css`
- `docs/library-and-line.md` and current workflow configuration docs
- `test/library-page-render.test.ts`, route/render/helper tests, and workflow label fixtures
- `e2e/specs/library.spec.ts` plus a focused Commands authoring spec if clearer than extending it

## Test plan

### Unit and render coverage

- Commands is appended as the sixth shelf and existing order remains unchanged.
- Shelf copy and four card facts derive only from the supplied live catalog.
- Cards have built-in status and no New affordance.
- route parse/serialize covers collection, each slot, invalid slot, invalid encoding, and `new`;
- editor draft parsing, dirty state, clean SSE adoption, dirty revision conflict, save success, and
  route selection;
- default and override add/edit/remove produce the Phase 1 update shape;
- Settings render no longer contains the command table but retains authorization and Trust link;
- visible node-label helpers say Command while serialized graph fixtures still use `kind: "check"`;
- existing Library shelves, legacy routes, workflow validation, and run outcome tests remain green.

### Required Playwright coverage

Drive the built daemon and dashboard, with all agent binaries still faked:

1. Open Library and assert Commands is the sixth question-led shelf with `test`, `lint`,
   `typecheck`, and `build` cards and no New Command card.
2. Open `test`; assert the durable hash and selected editor.
3. Enter a global default, inspect the exact argv preview, save, and assert the card/editor updates
   through live state.
4. Add a repository override, then a subdirectory override if the fixture supports it; save and
   assert the durable facts and paths.
5. Navigate away and back or reload, proving persistence and route restoration.
6. Simulate or issue a second revision update and prove a dirty draft is not silently overwritten.
7. Open a workflow, select `test`, add a Command node, assert the label/status and Library link,
   then publish or otherwise prove the serialized request still uses the existing node contract.
8. Open Workflow Settings and assert command authoring is absent while Allow workflow Commands,
   Trust summary, and the Library link remain.

Assert visible consequences through role, label, placeholder, and text selectors. Never spend model
tokens and never add `data-testid`.

### Runtime and visual verification

- Run the built dashboard at wide and narrow widths.
- Inspect all four slot states: empty, default only, overrides only, and default plus overrides.
- Exercise long repository paths, quoted arguments, parser error, save error, and revision conflict.
- Confirm Library header and safety copy do not imply direct execution.
- Capture screenshots or transcripts only in the repository's ignored evidence location or attach
  them to the PR. Do not commit evidence artifacts.

## Verification gates

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

Run the focused Playwright spec while iterating, then the full E2E suite after a successful build.
If Chromium is absent, install it once as documented in `e2e/README.md` rather than changing test
configuration.

## Merge and exit criteria

- Library has a native Commands shelf and editor consistent with adjacent surfaces.
- A global default can be configured without selecting a repository.
- Overrides preserve repository and monorepo behavior and remain visually secondary exceptions.
- Workflow authoring and run detail use Command while wire and persistence still use `check`.
- Settings contains policy and a route to Library, not a competing command catalog.
- Warning copy is consolidated, and all Phase 1 safety enforcement remains intact.
- Live updates, dirty drafts, CAS conflicts, navigation, narrow layout, documentation, and browser
  behavior are covered.
- All repository gates pass and the feature is complete with no later cleanup phase required.

## Phase compatibility audit

- This phase consumes Phase 1's catalog only through shared views, routes, and `MissionState`.
- It removes the temporary Settings authoring path only after the replacement editor works.
- It changes visible terminology without touching durable node kinds, slot ids, outcomes, runtime
  selection, migration, or process safety.
- It leaves one clear authoring source, one policy location, and one execution implementation.
