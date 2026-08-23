# Phase 2: Author-what-runs Library tour

## Outcome and value

Add the second user-started Mission Control product tour, **Author what runs**. It teaches the
authoring half of the product in dependency order, then connects the built-in No-Mistakes
Review definition to the way a real finished run appears in Runs and in a session's Workflows
tab. The tour is discoverable in Settings and the command palette, writes nothing, creates
nothing, spends no model tokens, and restores the exact surface and focus from which it began.

## Entry criteria and dependencies

- Phase 1 is merged and its registry, engine, namespaced targets, active-tour state, entry
  derivation, overlay, generalized skin, and route contract are present on `main`.
- `e2e/specs/see-work-tour.spec.ts` passes on that merged base.
- Re-read the source plan and Phase 1 pull request for recorded implementation deviations
  before extending its public contracts.

Direct dependency: Phase 1.

## Scope

### Included

- Register the `library` tour definition and its two discovery entries.
- Implement the approved 15 stops, 19 target beats, and targetless closing card.
- Register every target on the existing element owned by its current component.
- Navigate through built-in Personas, Session actions, the test Command slot, the built-in
  No-Mistakes workflow, one qualifying finished run, and its live session's Workflows tab.
- Select a run from App's SSE-backed summary collection and handle both fallback states.
- Refuse startup cleanly when the existing dirty-draft route gate blocks the first move.
- Restore route, Library asset selection, layout, fleet selection, drawer/filter state, and
  focus without writing any asset or run.
- Add unit, HTTP-adjacent, render, E2E, and geometry coverage.
- Update user and architecture documentation for two tours and correct the No-Mistakes v10
  sentence.

### Explicit non-goals

- No automatic or first-run start.
- No progress persistence or resume prompt.
- No new top-bar control.
- No tour for Missions, Sources, Ensembles, Foreman, Scouts, or external Pipelines.
- No edits, duplicates, saves, publishes, bindings, workflow submissions, demo tasks, or
  synthetic runs.
- No model invocation and no new server endpoint for run selection.
- No change to the No-Mistakes workflow graph or append-only version ids.

## Repository findings and inherited contracts

- Consume Phase 1's definition and navigation contracts. Do not add another controller or
  active state branch.
- `MissionRoute` already captures `shelf` and `assetId`; keep it as the sole restore value.
- App already receives every `WorkflowRunSummary` over SSE. Select the newest qualifying
  summary in memory using stable ordering, exact built-in workflow id, terminal status, and a
  currently live `sessionId`.
- `NO_MISTAKES_REVIEW_WORKFLOW_ID` is browser-safe in `src/shared/builtin-workflow.ts` and is
  the exact match required by the source plan.
- The planned DOM elements already exist and have accessible owners except for the combined
  Action contract: its chips and explanatory sentence are siblings. Group those two existing
  surfaces in one labelled Session action contract section rather than spotlighting only half
  the approved lesson. Other shared renderers need optional ref props; those props must not
  change ordinary markup when no tour runs.
- `requestWorkflowsTab(sessionId)` is App's existing way to reveal the session ladder.
- A session may disappear between stops 13 and 14. Retain the selected run summary so fallback
  copy can use its durable `sessionName` after the live collection drops the session.

## Proposed implementation route

### 1. Register the definition and runtime selection

- Add `library` to the tour registry with:
  - kicker and title **Author what runs**;
  - detail and keywords covering Library, Personas, Actions, Commands, Workflows, review, and
    No-Mistakes;
  - the exact 15 stable stop ids and copy approved by the source plan;
  - the exact ordered target list below;
  - prepare/ready/fallback/reconcile behavior expressed through Phase 1's engine contract.
- Cap every stop at two beats. Progress remains step 1 through 15 while Driver advances over
  nineteen targets plus the centered close screen.
- Choose a real built-in Persona and Session action already present in App's catalogs. Prefer
  stable shared ids when one already exists; otherwise select deterministically from active
  built-ins rather than creating a new durable id solely for the tour.

### 2. Register the 19 existing target owners

Use Phase 1's `library` namespace and keep registration in the component that owns the node:

| Stop | Target id | Existing owner to instrument |
| --- | --- | --- |
| The Library | `library-page` | `LibraryPage` main `.lib-page` |
| Persona library | `persona-rail` | `PersonaLibrary` aside labelled Persona library |
| What a Persona is | `persona-chips` | `LibraryPropertyChips` row in `PersonaEditor` |
| What a Persona is | `persona-guidance` | `PersonaEditor` section labelled Persona guidance |
| Editing one | `persona-primary-action` | promoted button rendered by `LibraryWorkspaceHeader` |
| Action library | `action-rail` | `SessionActionLibrary` aside labelled Session action library |
| Contract and instruction | `action-contract` | new semantic section labelled Session action contract around the existing chips, note, and contract line in `SessionActionEditor` |
| Contract and instruction | `action-instruction` | section labelled Session action instruction |
| A Command slot | `command-default` | existing default-command rule/input in `CommandLibrary` |
| Overrides and saving | `command-overrides` | existing override rules/add row in `CommandLibrary` |
| Overrides and saving | `command-save` | promoted Save Command button in `LibraryWorkspaceHeader` |
| The builder | `workflow-rail` | Workflow library and node palette aside |
| Draft and published | `workflow-surface-toggle` | Editing surface group |
| Draft and published | `workflow-publish` | existing disabled Publish button on the built-in |
| No-Mistakes Review | `workflow-pipeline-strip` | `PipelineFrame` strip in built-in Pipeline view |
| Binding it | `workflow-bind` | existing Bind to a session button |
| A run, moving | `run-pipeline-strip` | `RunPipeline`/`PipelineFrame` strip for the selected run |
| A run, moving | `run-worklist` | WorkflowRuns section labelled Review worklist |
| Where a run is watched | `session-workflow-ladder` | `WorkflowLadder` section for the selected run/session |

- Add optional semantic ref props to shared components only where the owning feature cannot
  attach Phase 1's ref directly. Candidates include `LibraryPropertyChips`,
  `LibraryWorkspaceHeader`, `PipelineFrame`, the worklist section, and `WorkflowLadder`.
- Preserve existing element type, accessible name, class, layout, focusability, and ordinary
  render when the ref is absent. The one allowed wrapper is the labelled Action-contract
  section above because the source plan's required chips and sentence have no common element;
  do not add `data-testid` or unnamed tour-only wrappers.
- Scope the session ladder target to the selected run and live session, just as See-work task
  targets are scoped to its demo task.

### 3. Implement navigation without simulating clicks

- The first stop navigates to `{ page: "library" }`. If the existing dirty-draft gate returns
  false, the engine remains inactive and the existing Leave-with-unsaved-changes dialog owns
  the decision.
- Persona stops navigate directly to a built-in Persona route.
- Action stops navigate directly to a built-in Session action route.
- Command stops navigate to `{ page: "library", shelf: "commands", assetId: "test" }`.
- Workflow stops navigate to the built-in No-Mistakes workflow in Pipeline mode. Use current
  selection and mode owners rather than forcing DOM clicks.
- Run stop 13 navigates to `{ page: "runs", runId }` and waits for the selected run pipeline
  and worklist targets.
- Run stop 14 returns to Fleet, selects and opens the same live session, and calls the existing
  Workflows-tab request owner so the matching ladder mounts.
- The closing card is centered and offers the existing See-work tour as the other learning
  path without auto-starting it.

### 4. Select the demo run and implement fallbacks

- On tour start, or immediately before the run chapter, select the newest summary that meets
  all of these conditions:
  1. `workflowId === NO_MISTAKES_REVIEW_WORKFLOW_ID`;
  2. `workflowRunIsOpen(status)` is false, using the shared predicate rather than copying the
     current terminal-status tuple into tour code;
  3. `sessionId` is non-null and currently names a live session in App.
- Preserve the selected summary on the active tour run. Do not silently switch to a newer run
  during the tour.
- If no summary qualifies, keep stops 13 and 14 as real progress stops but render the approved
  fallback copy against the built-in workflow surface. Back, Next, and Exit remain usable.
- If the session is evicted after stop 13, stop 14 falls back in place and names
  `run.sessionName` when available. Do not infer cleanup from `state === "exited"`; react to
  the live collection losing the session through the existing event path.
- A finished run of another workflow or an operator duplicate never qualifies.

### 5. Preserve read-only and restore contracts

- The tour never calls any save, duplicate, publish, bind, dispatch, submit, or completion
  action.
- Snapshot the existing complete route, layout, session selection, Board detail state, filter,
  Line drawer, and focus bookmark through Phase 1's one active-run owner.
- Restore exactly that snapshot on Exit and normal completion. Because the route contains
  Library shelf and asset id, do not maintain a parallel selected-asset snapshot.
- Restore the invoker semantically after the route remounts. Verify both the Settings button
  and palette command paths.
- Keep keyboard focus inside the coachmark and any declared live surface. Escape exits the
  tour unless an existing top app overlay owns the first Escape.

### 6. Documentation

- Replace the single comparison-spike heading in `docs/ui.md` with a Tours section that
  explains one engine, two user-started definitions, both entry points, and no progress
  persistence. Keep the Driver.js comparison history.
- Add the Library-tour pointer to `docs/library-and-line.md` and the No-Mistakes section of
  `docs/workflows.md`.
- Update README's See-work paragraph to describe both tours.
- Correct `docs/workflow-system.md` from version 9 to version 10 without changing version
  history.

## Data, API, migration, and compatibility

- No database, migration, shared wire shape, or ServerEvent change.
- No run-history HTTP request is added. App's SSE-backed `workflowRuns` collection is the
  selection source and existing run-detail loading remains owned by `WorkflowRuns` after
  navigation.
- No built-in asset or workflow id is renamed, reordered, or appended for this feature.
- The second tour has no server-side task recipe and must fail closed if a caller attempts a
  generalized dispatch/preview/cleanup operation for `library`.
- Existing See-work behavior and its 14-stop progress remain unchanged.

## Tests and verification

### Unit and render coverage

- Registry exposes exactly two definitions and derives two Settings and palette rows in a
  stable order.
- Library definition has exactly 15 unique stop ids, nineteen namespaced target beats, no
  ordinary stop over two beats, and one explicit targetless closing stop.
- Prepare/ready/fallback/reconcile behavior maps every stop to its route and target.
- Run selection accepts only exact built-in No-Mistakes terminal summaries with live sessions,
  chooses deterministically, rejects other workflows and duplicates, and retains durable
  session naming after eviction.
- Static render coverage proves the Help & tours list and each optional target-ref seam keeps
  accessible markup intact, and proves the Action chips and sentence share the labelled
  Session action contract region.
- Phase 1 target-registry and HTTP safety coverage remains green.

### Required Playwright spec

Add `e2e/specs/library-tour.spec.ts` and cover:

- start from Settings and from the palette;
- all 15 titles, nineteen spotlights, route hashes, progress values, and two-beat behavior;
- built-in Persona, Action, Command, and Workflow surfaces;
- no change to Persona, Action, Command, or Workflow API snapshots across a completed tour;
- a seeded finished built-in No-Mistakes run with a live session, including Runs pipeline,
  worklist, and session Workflows ladder;
- a terminal run of another workflow only, proving both run stops use fallback copy;
- session eviction between stops 13 and 14, proving durable-name fallback;
- dirty-draft startup refusal with no controller mounted behind the existing confirmation;
- Exit and completion restore the exact hash, surface, selection, and focus;
- desktop and narrow viewport geometry, including that coachmarks stay in the viewport and do
  not cover the control or surface they describe;
- no real agent binary or model token usage. Use only the existing fake-agent fixtures if a
  finished run must be seeded.

Keep `e2e/specs/see-work-tour.spec.ts` green without weakening its assertions.

Commands, from repository root:

```sh
node --test --import ./test/setup-state.mjs --import tsx \
  test/tour-target-registry.test.ts \
  test/palette-index.test.ts \
  test/settings-sidebar-render.test.ts \
  test/see-work-tour-http.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e -- \
  e2e/specs/see-work-tour.spec.ts \
  e2e/specs/library-tour.spec.ts \
  --workers=1
npm run test:e2e
```

## Merge and exit criteria

- Settings Help & tours and the command palette each show **See the work** and **Author what
  runs**, both derived from the same registry.
- Author what runs completes all approved stops without creating or mutating product state.
- Live-run, no-qualifying-run, and mid-tour-session-eviction paths remain navigable.
- Exit and completion restore route and focus from Settings, palette, Fleet, Library, and Runs
  entry points.
- The existing tour remains unchanged and green.
- Required repository and E2E gates pass, and successful UI evidence is produced only in the
  gitignored artifact area for PR review.
- Documentation matches the two-tour implementation and No-Mistakes v10.
- The pull request records and justifies any deviation from this proposed route.

## Downstream handoff

No later phase is planned. Future tours may rely on the same definition registry, target
namespace, one active-run owner, discovery derivation, and engine lifecycle. They must not
introduce a concrete-tour branch in generic App, Settings, palette, overlay, controller, or
server code.

## Cross-phase audit record

- Consumes every Phase 1 contract and creates no parallel source of truth.
- Owns all source-plan requirements not delivered by Phase 1: the second definition, nineteen
  Library/run/session targets, run selection and fallbacks, read-only navigation, docs, and
  new E2E coverage.
- Uses `MissionRoute` rather than an obsolete duplicate Library-selection snapshot.
- Uses App's SSE summaries rather than a redundant run-page fetch.
- Records and resolves the source plan's incorrect assumption that the Action contract already
  had one targetable DOM owner.
- Keeps target instrumentation with the visible feature so Phase 1 has no dead plumbing.
- Final audit status: all source requirements are covered exactly once; no undocumented
  cleanup phase remains.
