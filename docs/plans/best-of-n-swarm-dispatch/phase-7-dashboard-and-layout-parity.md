# Phase 7 — Dashboard Product Flow and Layout Parity

## 1. Outcome

Expose the backend as one coherent operator flow: configure and confirm an Ensemble from the existing dispatch surface, monitor generic runs under Workflows, inspect immutable evidence and Best-of-N scorecards, make explicit decisions, recover failures, and recognize every member in Cards, Console, and Board layouts.

The UI is descriptor-driven for launch configuration and generic run state. Best-of-N contributes only its result presentation, not a new route or lifecycle.

## 2. Entry Conditions and Dependencies

- Depends directly on Phase 6.
- Public preview/create/read/action APIs are stable and every action has typed current-state/revision conflicts.
- `ensembleSummaries` is present in the existing SSE snapshot/update stream.
- `TaskSummary.ensemble` contains the bounded member projection.
- Workflow source/run detail can link to an external Ensemble id.

## 3. Scope and Non-Goals

In scope:

- Single/Ensemble modes in the existing new-dispatch modal;
- persistent Ensemble draft/config/request identity and existing attachment behavior;
- descriptor-driven strategy cards and form renderer;
- side-effect-free launch preview and explicit confirmation;
- Ensemble list/detail routes inside the Workflows page;
- generic stage/member/artifact/evaluation/decision/finalization views;
- Best-of-N scorecards and select-one confirmation;
- action/recovery UI with stale-state handling;
- bidirectional Ensemble ↔ Workflow navigation;
- member signals and navigation in all three layouts/four session renderers;
- accessibility, responsive layout, route, render, and compose regression tests.

Out of scope:

- a new top-level page, overlay launcher, or EventSource;
- a new keyboard shortcut;
- a second composer or new `DraftKind`;
- client-side strategy compilation or authority;
- polling run detail;
- automatic decision/finalization;
- arbitrary JSON configuration forms;
- layout-specific lifecycle logic.

## 4. Repository Findings That Shape the Work

- `DispatchLayer` owns the new-task draft across modal unmount. `DispatchModal` owns transient fetch/error/pending state and already serializes attachments with `withAttachments`.
- Backlog editing reuses `DispatchModal`; it must stay Single-only because an existing Task cannot be transformed into an Ensemble.
- Dispatch attachments deliberately survive modal unmount and are revoked on successful submit/reset, not close. Upload state guards both buttons and keyboard submission.
- `WorkflowTab` / `MissionRoute` in `src/web/workflows/useWorkflowRoute.ts` are closed unions over Workflows, Personas, and Runs.
- `AppPageShell` has only Fleet and Workflows pages. Ensembles belong inside the Workflows page; no new top-level shell branch is needed.
- App owns the one `useEventStream` state and passes summaries down. Detail pages use HTTP for large data.
- Layout-visible props must enter `SessionViewProps` / `cardProps`. Cards, Console detail, Board tile, and Console/Board rail use separate renderers.
- Shared leaves live in `src/web/components/session-bits.tsx`, while Rail/Tile/Card mark vocabularies still require explicit parity work.
- Workflow marks may already coexist with Task and other session signals; Ensemble and Workflow must remain visually/accessibly distinct.

## 5. Implementation Steps

1. Extend the lifted dispatch draft without breaking backlog edits.
   - Keep one base compose draft for repo, title, intent, priority, labels, and attachments.
   - Add `launchMode: "single" | "ensemble"` only for `mode.kind === "new"`.
   - Preserve the current Single fields and add an `EnsembleDispatchDraft` containing stable request UUID, strategy/version, strategy config, roster, evaluator guidance selection, optional Workflow version/mode, and last validated preview fingerprint.
   - Store both variants in `DispatchLayer`, so switching mode or closing/reopening loses neither.
   - Force edit mode to Single and keep `taskUpdatePatch` behavior unchanged.
   - Extend draft equality/reset helpers so an async response clears only the exact submitted draft. Rotate the Ensemble request UUID only after accepted creation or explicit Clear/Revert.

2. Reuse the existing compose and attachment contract.
   - Render one title/intent/repo/priority/labels/attachment area for both launch modes.
   - Call `withAttachments` once before Single or Ensemble submission; the server receives the same serialized intent format.
   - Keep image state, `useImageDrop`, drop props/veil, paste, `AttachmentStrip`, upload guards, revoke policy, and reset behavior unchanged.
   - Do not add a `DraftKind`: DispatchLayer is already the dispatch surface and no new text box is introduced.
   - Ensemble launches immediately; hide “Add to backlog” in Ensemble mode because the durable Ensemble run itself owns its member backlog wave.

3. Render strategies from the browser-safe registry.
   - Add a generic strategy-card picker using `ENSEMBLE_STRATEGY_INFO`.
   - Render the bounded `StrategyFormSpec` controls with one shared form renderer: numeric bounds, enum choices, boolean policies, roster rows, model/effort selections, guidance selector, and Workflow placement.
   - Best-of-N is the only enabled v1 card. Future registered-but-disabled descriptors may render a reason without becoming selectable.
   - Allow duplicate roster rows deliberately. Each row owns harness, model, effort, role, and optional approach; model/effort options derive from existing harness capability/model data.
   - Never accept arbitrary strategy JSON from a textarea.

4. Add Workflow and evaluator selectors.
   - Use live Persona summaries/defaults for evaluator guidance and display the exact revision that preview will pin.
   - Use published Workflow version APIs and current engine capability status for optional after-selection placement.
   - Show version, mode, trigger/delivery defaults, round cap, final gate, and current prerequisites.
   - Disable unsupported Live/Foreman choices with the backend-provided reason; never relabel them Preview.
   - Mark that Workflow begins only after selection and is not part of candidate comparison.

5. Add a review-before-launch step.
   - “Review launch” posts the current draft to `POST /api/ensembles/preview`.
   - Show the preview's initial and maximum members, concurrency, waves, artifact kind, evaluation count, model-call ceiling, destructive decision requirement, ref retention, information-sharing policy, publishing prohibition, estimated provider/model selections, and Workflow placement. State separately that create pins the exact base commit at launch; preview does not claim a SHA that create has not pinned yet.
   - Present server validation errors next to their source fields.
   - Fingerprint the normalized preview input; any subsequent draft change invalidates confirmation.
   - The final “Launch N agents” action uses the same stable request UUID and current fingerprint. It remains disabled while attachments upload or preview is stale.
   - On response loss, retry returns/navigates to the same run.

6. Extend the Workflow hash route and tabs.
   - Append `"ensembles"` to `WorkflowTab`.
   - Extend `MissionRoute` with optional `ensembleId`, parsing and emitting
     `#/workflows/ensembles` and `#/workflows/ensembles/:id`.
   - Update `WorkflowPage` tab registry/render switch; do not hand-maintain tab count in multiple places.
   - Keep `AppPageShell.page` as `"fleet" | "workflows"` and keep the fleet EventSource mounted.
   - Reuse the existing dirty Workflow/Persona navigation guard for Ensemble route changes.

7. Add the Ensemble list and detail controller.
   - Create `src/web/workflows/EnsembleRuns.tsx` and focused child components under
     `src/web/ensembles/`.
   - List from live `ensembleSummaries`; support status/strategy/repo filters and attention-first sorting without a second fetch loop.
   - Fetch detail only for the selected route id. Abort stale requests and refetch when that run’s SSE summary revision/updated time changes; do not poll.
   - Render missing/deleted runs explicitly and allow Back/Forward to remain authoritative.
   - Add typed functions to `src/web/lib/api.ts` for preview, create, detail, evidence/patch, submission fallback, actions, and delete.

8. Render a generic durable run detail.
   - Header: strategy/version, status, active stage, pinned base, repo, elapsed time, aggregate agent/review cost, budget use, and attention/error.
   - Members: group by wave/role, show lineage, Task/session link, harness/model/effort facts, attempt state, artifact state, reported claims versus observed evidence, and result label.
   - Timeline: stage dependencies/barriers, attempts, retries, commands, evaluations, decisions, finalization receipts, and recovery errors.
   - Artifacts: immutable fingerprint/ref/short SHA, base relationship, stats/binary/truncation, on-demand bounded diff, and Restore.
   - Evaluation: actual provider/model, call attempts, subject set, uncertainty, and result payload through a strategy result-renderer registry.
   - Outcome/handoff: selected/materialized Task, retained/eliminated members, pinned Workflow version/settings, handoff state, binding/run link, and exact reviewed SHA.

9. Add the Best-of-N result renderer and decision panel.
   - Render anonymous scorecards with rank, score, strengths, risks, rationale, confidence, recommendation, caveats, and evidence/truncation warnings.
   - Reveal Task/member identity in the operator view after evaluation while preserving the evaluator’s anonymous labels/provenance.
   - Let the operator select any eligible ready artifact, including one not recommended.
   - Require explicit inline destructive confirmation and rationale before posting `decide`.
   - Show exactly what will be retained, reset/materialized, cancelled, and optionally handed to Workflow.
   - After submission, render durable finalization progress rather than optimistically declaring a winner.

10. Add state-aware generic actions.
    - Focus Session/Task; manual Submit fallback; retry member/stage; withdraw; cancel; restore artifact; retry/skip Workflow handoff; retry finalization; and explicit terminal delete.
    - Render actions from current generic capabilities/state supplied by detail, not from Best-of-N status checks scattered through components.
    - Carry expected status and request id; on `409`, refetch detail and show the new state without replaying automatically.
    - Keep dangerous confirmations inline in the detail. Do not create an unregistered overlay.
    - Delete requires the exact run id and explains that Tasks/linked Workflow remain while private Ensemble refs/history are removed.

11. Link Ensemble and Workflow histories.
    - From Ensemble detail, navigate to the linked Workflow Run through the existing Runs route.
    - In Workflow Run detail, turn Phase 1 external-source provenance into an Ensemble deep link when `sourceKind === "ensemble"`.
    - Render reset/deleted linked Workflow as removed rather than fabricating a run.
    - Keep both statuses visible: Ensemble completion does not imply Workflow approval/shipping.

12. Add one shared Session leaf and all layout props.
    - Implement `EnsembleChip` in `src/web/components/session-bits.tsx`.
    - Add `onOpenEnsemble` (and any App-owned summary lookup truly needed) to `SessionViewProps` and `cardProps`.
    - Pass it from App to every layout; `GridView` must not be able to drop it.
    - `SessionCard` and `ConsoleDetail` use the same `EnsembleChip`.
    - `SessionTile` adds an accessible `tile-flag` with ordinal/role/state.
    - `RailRow` adds an accessible `E` mark plus bounded `resultLabel`.
    - Clicking Ensemble marks routes to its detail; Workflow marks continue routing to Workflow Run.
    - Keep distinct E/W labels and stable chip ordering when both coexist.

13. Finish responsive and accessible behavior.
    - Strategy controls and scorecards collapse to one column at narrow widths.
    - Tabs, roster controls, evidence toggles, decision choices, and action errors are keyboard reachable.
    - Use semantic headings, tables/lists where appropriate, `aria-current` for routes, live regions for submit/finalization state, and text labels in addition to color.
    - Large patches render in bounded/preformatted containers and are fetched only on demand.

## 6. Data, API, and Migration Details

- No database migration is expected.
- Use `ensembleSummaries` from the one `MissionState`; do not mirror full detail into App state or local storage.
- Persist the unsent dispatch draft in the existing lifted in-memory owner only. Existing product behavior does not promise survival across a browser reload.
- The preview response is advisory about mutable preflight facts; create revalidates and may return a precise conflict.
- Strategy form specs and result-renderer ids are registries. A new strategy using existing fields/routes/states adds data and a result view, not a new page.
- CSS changes stay in the existing stylesheet/component conventions; no external assets or runtime dependencies are required.

## 7. Tests and Verification

Add focused tests for:

- route parse/format/list/detail and Back/Forward;
- Workflow dirty-draft navigation guard with Ensemble routes;
- new-dispatch Single/Ensemble switching retains both drafts;
- backlog edit remains Single and unchanged;
- request UUID survives close/retry and rotates only on success/Clear;
- all attachment upload/paste/drop/revoke/reset/keyboard guards remain correct;
- descriptor registry/card count and generic form rendering;
- invalid/stale preview prevents launch; response-loss retry navigates to the same run;
- disabled incompatible Workflow modes and exact pinned revision display;
- SSE summary update triggers bounded selected-detail refetch without polling;
- generic detail renders stages/members/artifacts/evaluations/finalization/recovery;
- Best-of-N scorecards, nonrecommended selection, explicit confirmation, 409 refresh, and progress display;
- Workflow ↔ Ensemble links, including removed linked state;
- `EnsembleChip` leaf parity and `onOpenEnsemble` propagation through `SessionViewProps`/`cardProps`;
- SessionCard, ConsoleDetail, SessionTile, and RailRow each expose the Ensemble signal;
- E/W marks coexist with accessible labels;
- narrow viewport and keyboard smoke coverage.

Run:

```text
npm run typecheck
node --test --import tsx test/workflow-route.test.ts test/workflow-page-render.test.ts
node --test --import tsx test/ensemble-dispatch-render.test.ts test/ensemble-page-render.test.ts
node --test --import tsx test/session-leaf-parity.test.ts test/layout-parity.test.ts
node --test --import tsx test/overlay-registry.test.ts test/keybindings.test.ts
npm run build:web
npm run smoke
npm test
```

## 8. Merge Criteria

- A user can review an exact launch plan, start one idempotent Best-of-N run, and navigate directly to it.
- The list/detail remain current from one SSE stream plus bounded event-triggered HTTP reads.
- Evidence, recommendation, human override, destructive scope, progress, and remediation are legible.
- No client path auto-decides or broadens backend authority.
- Dispatch compose parity and backlog edit behavior remain intact.
- All four Session renderers expose a working, accessible Ensemble signal in every layout.
- Workflow and Ensemble statuses/links coexist without conflation.

## 9. Downstream Handoff Contract

Phase 8 may rely on:

- one generic strategy form renderer and result-renderer registry;
- one reusable Ensemble list/detail route family;
- one action surface driven by server capabilities/state;
- tested compose, routing, SSE/detail, and layout contracts;
- Best-of-N as the only enabled production strategy with no lifecycle special case outside its descriptor/result renderer.

Phase 8 must prove new strategy shapes reuse these surfaces rather than adding strategy-specific routes, Session fields, or orchestration branches.

## 10. Cross-Phase Compatibility Audit

Checked against repository baseline `57ea5bc` and Phases 1–6.

- Extends the existing Workflows hash shell rather than adding a top-level page/EventSource.
- Keeps App as state owner and routes layout-visible callbacks through `SessionViewProps`/`cardProps`.
- Updates all four session renderers and all three mark vocabularies.
- Adds the shared leaf in `session-bits.tsx`.
- Reuses the single dispatch composer and all six attachment pieces; no new `DraftKind` or overlay is introduced.
- Adds no shortcut, so no keybinding/CommandBar/README shortcut registry change is required.
