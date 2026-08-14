# Phase 2: The Blocker Worklist reader pane

## Outcome

The "Reviewer verdicts" section of the Workflow runs reader pane becomes a two-column blocker
worklist: the changes a run is asking for on the left, the selected one in full on the right,
passing reviewers behind a segmented control, and a stalemate card when reviewers have failed
consecutive rounds.

This is the phase a person sees.

## Entry criteria and dependencies

- **Direct phase dependencies:** Phase 1.
- Requires `runChangeWorklist` and `ChangeWorklistRow` exported from `run-model.ts`, with rows
  pre-sorted and `state` partitioning open from resolved.

## Scope

- Replace the `Reviewer verdicts` section in `WorkflowRunView`.
- Render `detail.repeatOffenders` as a stalemate card.
- Styles for the new surface in `src/web/styles.css`.
- Update the existing e2e spec that asserts the old section, and add one for the worklist.

### Non-goals

- The stage pipeline, the run header, the round scrubber, the run rail and its filters. All
  unchanged.
- The `Captured intent and evidence` section, the deliveries, model-call and timeline
  sections, and the audit disclosure. All unchanged and still below the worklist.
- Any route change. Selection is local state.
- Any server, schema or wire change.
- New `data-testid` attributes. Prohibited by the repository's e2e contract.

## Repository findings

- The section to replace is `WorkflowRuns.tsx:972-1047`, which maps `reviewAttempts` through
  `CheckCard` (225-265), `VerdictCard` (374-424), or a bare-attempt fallback (1005-1019), then
  renders two `<details>` join-packet disclosures (1022-1046).
- `reviewAttempts` is built at `WorkflowRuns.tsx:563-592` from
  `reviewerAttempts(roundAttempts.filter(a => a.sessionAction === null), version?.graph)`.
  The worklist replaces the *verdict* rendering; **check outcomes still need `CheckCard`**, and
  the empty-state arms (`inspectorOnly`, `reviewerlessVersion`) still need their sentences.
  This is the part of the mockup that is under-specified: it drew only persona verdicts.
- `detail.repeatOffenders` reaches this component and is discarded. `WorkflowLadder.tsx:483-487`
  is the only renderer, using the sentence `{personaName} has failed {rounds} rounds running.`
  Reuse that wording so two surfaces do not describe one fact two ways.
- Existing per-node actions already exist and are wired: `POST .../set-persona-directive` and
  `.../remove-persona-directive` (`WorkflowRuns.tsx:930-934`), `POST .../set-nodes-disabled`
  (924-927). Both are **withheld once the run is terminal** - the worklist's per-change actions
  must respect the same rule.
- `copyFeedbackAction` (`run-actions.ts:73-90`) backs the header's Copy feedback and is
  disabled unless a delivery payload or verdict exists. "Copy this change" is a new, narrower
  action over a single `ChangeWorklistRow`.
- `PersonaDirectiveEditor.tsx` is the existing modal for "critical Persona feedback"; the
  worklist's "Give this reviewer feedback" opens it rather than inventing a second editor.
- The e2e fail fixture (`e2e/fixtures/fake-claude.mjs:259`) emits **one** requested change,
  titled `E2E requested change`, with **no `path`**. Any spec asserting a file line will fail.
- `e2e/specs/workflow-run-reviewer-verdicts.spec.ts` asserts the old section's behavior
  (structural nodes must not render as verdict cards). It reads cards by their chip. **It will
  break** and must be updated in this phase, not left for later.

## Implementation steps

### 1. Derive and partition

In `WorkflowRunView`, call `runChangeWorklist(detail)` once. Partition by `state` into
`blocking` and `archive`. Keep the existing `reviewAttempts` derivation for checks and for the
`Passed` segment.

### 2. Selection state

`const [selectedKey, setSelectedKey] = useState<string | null>(null)`, resolved to the first
`blocking` row when null, mirroring how `roundId` is held. Reset when `detail.run.id` changes.
If `selectedKey` no longer resolves after a refresh, fall back to the first blocking row rather
than rendering an empty pane.

### 3. The rail

- Segmented control: `Blocking {n}` / `Passed {n}` / `Archive {n}`. Implement as buttons with
  `aria-pressed`, not `data-testid`.
- Blocking rows: title, path when present, `{personaName} · round {firstRound}`.
- Archive rows: green rail, `Resolved in round {lastRound}`.
- Passed segment: one line per passing reviewer and per check, reusing the existing
  `CheckCard` for checks so their exit code and output tail are not lost.
- Stalemate card at the foot when `detail.repeatOffenders` is non-empty, using the ladder's
  sentence.

### 4. The detail pane

For the selected row: the reviewer's verdict summary, a `chip` for its state, confidence,
runner and model from `verdictMeta`. Facts row: file (or "No file cited"), first raised,
rounds open, evidence count. The rationale in full. Evidence quotes. Then the action row:

- **Copy this change** - title, path, rationale to the clipboard.
- **Open file** - only when `path` is present.
- **Give this reviewer feedback** - opens `PersonaDirectiveEditor` for that `nodeId`.
- **Disable {personaName}** - the existing `set-nodes-disabled` call for that `nodeId`.
- Previous / Next to walk the partition.

Withhold the two mutating actions when the run is terminal, matching the existing per-node
menus.

### 5. Empty and degenerate states

Every arm the old section had must survive:

- No reviewers activated yet, Inspector-only round, reviewerless workflow: keep the existing
  sentences.
- Reviewers ran and all passed: the rail opens on `Passed` with `Blocking 0`, and the detail
  pane says the run has nothing outstanding rather than rendering blank.
- A run with checks but no personas still shows its checks under `Passed`.

### 6. Styles

Add the worklist styles to `src/web/styles.css` beside the existing `.wf-run-*` block, reusing
the existing tokens and chip classes. Two independent scroll regions (rail and detail) sit
under an already-tall pipeline; give the split a bounded height so the page does not grow a
third scrollbar.

### 7. Tests

- **Update** `e2e/specs/workflow-run-reviewer-verdicts.spec.ts`. Its requirement survives the
  redesign - structural nodes must still not appear as things a reviewer said - so re-point it
  at the worklist rather than deleting it.
- **Add** `e2e/specs/workflow-run-blocker-worklist.spec.ts`: drive a real dispatch with a
  Persona carrying `E2E_FAIL_VERDICT`, open the run, and assert the change appears in the
  Blocking segment, that selecting it shows its rationale, and that the Passed segment holds
  the passing reviewer. Assert by role and accessible name only. Do not assert a file path -
  the fixture emits none.
- **Add** a `renderToStaticMarkup` case in `test/` pinning the stalemate sentence, mirroring
  `test/workflow-ladder-repeat.test.ts`.

## Data, API and migration

None.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright install chromium   # once per machine
npm run test:e2e
```

`npm run test:e2e` is mandatory here: this is a UI change, and the repository's contract
requires a Playwright spec for every UI change with no exemptions.

## Merge and exit criteria

- The worklist renders for a run with open changes, and selecting a row shows its detail.
- A change carried from an earlier round says which round raised it and how many rounds it has
  been open; a resolved one says which round resolved it.
- `repeatOffenders` renders, using the same sentence as the ladder.
- Every empty and degenerate arm from the old section still renders its sentence.
- The pipeline, header, round scrubber and run rail are unchanged in behavior.
- The updated and new e2e specs pass; the full unit suite, typecheck, lint, build and smoke
  are green.

## Downstream handoff

There are no later phases. Future work that touches this surface should know:

- Selection is local state by design. Routing it means touching `parseMissionRoute`,
  `missionRouteHash` and the `onFilters` handler in `App.tsx:2408-2412`, which drops any route
  field it does not spread.
- The worklist and the stalemate card must keep agreeing about what a round is. Both descend
  from the round-folding rule in `repeat-offender.ts`.

## Cross-phase audit record

- **Reconciled against Phase 1.** Phase 1 promises pre-sorted rows and a `state` that
  partitions the segments; this phase does no sorting and no re-filtering, so the contract
  holds in both directions.
- **Discrepancy found and resolved.** Phase 1's handoff described the rows as sufficient for
  the section, but the section it replaces also renders **check outcomes** and three empty-state
  sentences that carry no requested changes at all. `runChangeWorklist` was not widened to
  cover checks - that would have made it a view model rather than a change model. Instead this
  phase keeps the existing `reviewerAttempts` / `checkOutcomeOf` path for the `Passed` segment
  and uses the worklist only for the `Blocking` and `Archive` segments. Phase 1's scope is
  unchanged; its handoff section is the record of the boundary.
- **Checked the e2e fixture against the mockup.** The mockup drew a path on every row; the
  fixture emits none and the type makes it optional. Both phases record the pathless case, and
  Phase 1's test list pins it so this phase inherits a derivation that cannot crash on it.
- **Confirmed no concurrency.** Phase 2 depends on Phase 1 and there is no third phase, so
  there is nothing to run in parallel and no merge-order ambiguity.
