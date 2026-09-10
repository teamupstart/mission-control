# Phase 3: Goal provenance signals on the run

## Outcome and value

When a run freezes an ask, it says what kind of ask it froze, records that on the run, and shows
it in run detail. An ask that matches a payload Mission Control types itself, one that is too
short to be a completion contract, or one taken while the session's newest instruction was still
unreconciled is visible immediately instead of being discoverable only by querying SQLite months
later.

This is the instrument for the rest of the plan. The defect that produced this work ran for
months in the operator's own state with nothing on any screen saying so, and the same silence
would hide a regression in Phase 1.

## Entry criteria and dependencies

- Direct prerequisite: Phase 1 merged.
- Concurrent with Phase 2; neither reads the other's fields.
- Inherits from Phase 1: `primaryGoal.rawPrompt` is the durable objective, and
  `WorkflowRunIntentSnapshot.intentSource` carries the objective version, prompt revision,
  resolved prompt revision and relationship the freeze was taken at.

## Scope and non-goals

In scope:

- A pure classifier over a frozen ask and its provenance.
- Storing its verdict on the run, emitting one run event, and rendering it in run detail.
- Regression tests that freeze against each known automated payload shape.

Non-goals:

- No refusal. A suspicious ask is reported, not blocked: the operator decides. The report
  proposed refusal as an option and this phase deliberately takes the reporting half only, so
  the first version cannot strand a run on a false positive.
- No steering rendering (Phase 2), no change to capture, criteria, or the fingerprint.
- No re-classification of existing runs. The verdict is written at freeze time.

## Repository findings and inherited contracts

- The five payload shapes measured in the frozen intents of the operator's live state, with the
  code that composes each: `src/server/foreman/ship-shepherd.ts:281` (4 runs),
  `src/server/foreman/review-followup.ts:412` (2), `src/server/workflows/feedback.ts:380` (2),
  `src/server/workflows/feedback.ts:300` (1), `src/server/sdk/supervisor.ts:66` (1).
- `isWrapupPayload` (`src/shared/queue.ts:232`) is the existing precedent for recognising this
  daemon's own prose by comparison against the constants it can have emitted, including retired
  ones. Its append-only `RETIRED_WRAPUP_PAYLOADS` rule applies here for the same reason: a
  frozen ask outlives the build that captured it.
- Runs already carry structured per-run JSON columns written at creation (`intent_json`,
  `run_criteria_json`, `src/server/workflows/store.ts:637`), and `appendEvent`
  (`manager.ts:5984` and neighbours) is the established way a run says something happened.
- `intentState` already has a vocabulary for a run whose ask cannot be trusted -
  `never_frozen`, `unreadable` (`store.ts:546`). The provenance verdict is a different axis and
  must not be folded into it: `unreadable` means the row is damaged, this means the row is
  intact and suspicious.
- Run detail's intent surface is `src/web/workflows/WorkflowRuns.tsx:2331`, fed by
  `run-model.ts:1465`.

## Implementation steps

1. **Classifier.** A pure module, `src/server/workflows/goal-provenance.ts`, taking the frozen
   ask and its `intentSource` and returning one of `objective`, `unreconciled`, `implausible`,
   `automation`, with the reason. `automation` compares against the daemon's own payload
   constants, append-only like `RETIRED_WRAPUP_PAYLOADS`. `implausible` uses a stated character
   floor with its rationale recorded in the module, not a magic number.
2. **Store the verdict.** Add `intent_provenance_json` to `workflow_runs` with its migration
   beside the others in `src/server/db.ts`, written in the same transaction that inserts the run
   (`createInitialSubmission`, `store.ts`), so a run can never exist without one. Absent on
   legacy rows, which read as "not classified" rather than as `objective`.
3. **Announce it.** Append one `run_intent_classified` event when the verdict is anything other
   than `objective`, carrying the verdict and reason. One event at freeze, never on every
   submission.
4. **Show it.** A badge beside the ask in run detail naming the verdict, with the reason in its
   accessible name, plus the corresponding fields on the run model. `objective` renders nothing:
   a badge on the healthy case is noise on every run.
5. **Regression suite.** Pin each of the five known payload shapes as `automation`, and pin that
   a genuine objective and a genuinely short but real ask are not misclassified. These are the
   tests that would have caught the original defect.
6. **Documentation.** One paragraph in `docs/workflows.md` describing the verdict and stating
   that it reports rather than blocks.

## Data, migration and compatibility

- One additive nullable column on `workflow_runs`. No backfill and no re-classification: the
  verdict describes the moment of the freeze, and inventing one for a historical row would make
  the record claim something nobody measured.
- Independent of Phase 2's snapshot field: this phase reads `intentSource`, which Phase 1 owns,
  and writes its own column.
- The classifier is pure and framework-free so it can be unit tested without a database, in
  keeping with the repository's preference for `node:test` over a rendering harness.

## Tests and verification

- `test/workflow-goal-provenance.test.ts`: each known payload shape classifies as `automation`;
  a short steering prompt as `implausible`; an unreconciled newest revision as `unreconciled`; a
  real objective as `objective`.
- `test/workflow-run-lifecycle.test.ts`: the verdict is written in the same transaction as the
  run, is absent for a legacy row, and produces exactly one event.
- `e2e/specs/workflow-run-intent-provenance.spec.ts`: a run frozen against an automated payload
  shows the badge in run detail, and a healthy run shows none.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- Every new run carries a provenance verdict; no existing run is retroactively classified.
- A suspicious ask is visible in run detail and in the run's event stream without blocking it.
- The five known payload shapes are pinned by test.

## Downstream handoff

Nothing later depends on this phase. It owns the classifier, the run column, the event and the
badge. A future proposal D (an operator-owned goal correction) would consume this verdict as its
trigger and must not redefine it.

## Cross-phase audit record

- Reconciled against Phase 1: reads `intentSource` and `rawGoal` only, writes a separate column,
  and leaves the snapshot shape, the fingerprint and the opening-ask rule untouched.
- Reconciled against Phase 2: disjoint. Phase 2 adds a snapshot field and a Persona section;
  this phase adds a run column, an event and a badge. The only shared file is
  `WorkflowRuns.tsx`, where each adds a distinct element beside the intent block, so the two
  merge in either order with at most a textual conflict.
