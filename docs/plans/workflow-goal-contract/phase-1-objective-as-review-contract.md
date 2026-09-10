# Phase 1: The durable objective is the review contract

## Outcome and value

A workflow run freezes the session's durable objective as the ask it reviews against, with the
human's opening request preserved beside it. A prompt that only steered the work -
`continue`, `create pr`, `you still working?` - stops becoming the contract a Persona measures
the diff against and stops being distilled into the run's acceptance criteria. The Persona
prompt shows the contract and the words the human actually typed, so nothing a reviewer used to
see is lost.

Measured on the operator's live state, 21 of 25 runs carrying a frozen intent were judged
against something other than the session's durable objective. In every row checked where the
captured prompt was wrong, the objective was correct.

## Entry criteria and dependencies

- Direct prerequisite: the planning pull request that publishes these artifacts.
- No phase dependencies.
- Anchors verified at `8cc4bb6e`.

## Scope and non-goals

In scope:

- Persisting the session's opening ask so it survives an `amend` or `replace`.
- Building the run's frozen intent from the durable objective plus that opening ask, with
  provenance describing which objective version and prompt revision it came from.
- Rendering the contract and its provenance in the Persona prompt and in run detail.

Non-goals:

- No change to how prompts are captured, classified, or reconciled. The refiner's verdict is
  consumed, never modified.
- No steering section in the Persona prompt (Phase 2) and no provenance verdict or badge
  (Phase 3).
- No change to the intent fingerprint's derivation, and no rewriting of any existing run.
- No change to what the session card displays.

## Repository findings and inherited contracts

- `readLiveWorkflowIntent` (`src/server/workflows/context.ts:993`) is the only place a workflow
  reads the Goal, and it is shared by the freeze (`readWorkflowIntentSnapshot`,
  `context.ts:1031`) and by the legacy live-read path in `readWorkflowContextRaw`. Changing it
  once changes both, which is why it was written that way.
- **Every captured prompt is already clamped.** `captureAcceptedPrompt` calls `clampPrompt`
  (`src/server/util/prompt-text.ts:30`), which caps at `PROMPT_CAP` of 4,000 characters and
  elides the middle rather than the tail. The opening ask is therefore the clamped opening
  prompt, exactly as `objective` and `prompt` already are; it is not byte-verbatim for a
  request over that cap, and this plan says so rather than promising something the pipeline
  cannot deliver. Storing an unclamped copy is rejected: `clampPrompt` exists so a pasted log
  cannot put a megabyte in a row, and a second unbounded column would reopen that.
- `captureAcceptedPrompt` (`src/server/registry.ts:7589`) sets `objective: raw` only when
  `firstObjective` is true. The refiner replaces `objective` wholesale on a `replace`
  (`src/server/goal/refiner.ts:399`), and `pendingPrompts` is truncated as revisions resolve
  (`refiner.ts:424`), so **the opening ask is not recoverable from the goal row** and must be
  persisted at capture time.
- `SessionGoal` is `src/shared/types.ts:1117`; its row mapper, upsert and migrations are
  `src/server/db.ts:10195`, `:10204` and `:4139`. `SetGoalSchema` is
  `src/shared/protocol.ts:1511`.
- `WorkflowRunIntentSnapshot` is `src/shared/workflow.ts:3582` and its zod schema is
  `src/shared/protocol.ts:5417`. The schema is non-strict, so a field absent from it is
  stripped by `frozenIntentJson` (`src/server/workflows/store.ts:637`) on the way in and by the
  reader on the way out.
- `workflowRunIntentFingerprint` is recomputed on read and a mismatch marks the run
  `unreadable` (`store.ts:560`), which the manager reports as a blocked run
  (`manager.ts:6173`). The fingerprint must keep covering exactly `{rawGoal, refinedGoal,
  decisions}`.
- The Persona prompt's intent section is `src/server/workflows/prompt.ts:80`. Run detail is
  `src/web/workflows/WorkflowRuns.tsx:2331`, fed by `src/web/workflows/run-model.ts:1465`.

## Implementation steps

1. **Persist the opening ask.** Add `openingPrompt: string | null` to `SessionGoal`, holding the
   clamped opening prompt - the same value `objective` is seeded from, so the two cannot
   disagree about what was asked.
   (`src/shared/types.ts`), `opening_prompt` to the `session_goals` CREATE TABLE and to
   `migrate()` beside the existing `addColumn` calls (`src/server/db.ts:1009`, `:4139`), and
   carry it through `rowToGoal` and `upsertSessionGoal`. A row written before the column exists
   reports `null`.
2. **Write it once.** In `captureAcceptedPrompt` (`src/server/registry.ts:7589`), set
   `openingPrompt` in the same `firstObjective` branch that seeds the objective, and never
   elsewhere. Add it to `SetGoalSchema` only if `upsertGoal`'s merge needs it; prefer keeping it
   out of the loopback patch surface so nothing can overwrite it later.
3. **Read the contract, not the last prompt.** In `readLiveWorkflowIntent`
   (`src/server/workflows/context.ts:993`) build `primaryGoal.rawPrompt` from
   `goal.objective`, falling back to `goal.prompt` when a session has no objective yet (its
   first instruction has not been reconciled, which is the only state where they differ
   legitimately). Keep `refined` as `goal.text`.
4. **Freeze the provenance.** Extend `WorkflowRunIntentSnapshot` with `openingAsk: string |
   null` and `intentSource: { objectiveVersion: number; promptRevision: number;
   resolvedPromptRevision: number; relationship: IntentRelationship | null } | null`, add both
   to `WorkflowRunIntentSnapshotSchema`, and populate them in `readWorkflowIntentSnapshot`.
   `null` for both is the honest reading of a legacy row and of a session with no objective.
5. **Keep the fingerprint still.** Do not touch `workflowIntentFields`
   (`src/server/workflows/intent-fingerprint.ts:26`). Add a test that a snapshot carrying the
   new fields hashes identically to one without them, so the exclusion is pinned rather than
   assumed.
6. **Carry it into capture.** Thread `openingAsk` through `RawWorkflowContext.primaryGoal` and
   `WorkflowContextSnapshot` (`src/shared/protocol.ts:5284`), bounded by the same `MAX_GOAL`
   clip the other goal fields use.
7. **Render it for Personas.** In `src/server/workflows/prompt.ts:80`, keep the section heading
   and print the objective as the contract, then the opening ask under a label that says what it
   is - the request this contract was derived from - and only when it differs from the contract.
   Do not reorder or rename the surrounding sections; the Persona guidance below them is
   published content that reads against this layout.
8. **Show it in run detail.** Rename the "Original goal" disclosure to name what it now holds,
   add the opening ask beside it when present, and extend `run-model.ts:1465` with the
   characters and presence flags the view needs.
9. **Documentation.** Update the intent paragraph in `docs/workflows.md:732` and the Goal
   section of `docs/sessions.md` to say that a run freezes the durable objective and keeps the
   opening ask beside it.

## Data, migration and compatibility

- One additive nullable column. No backfill: a session that predates it has no opening ask and
  reports `null`, which renders as absent rather than as an empty string.
- Snapshot fields are additive and optional in the zod schema, so a run frozen by an older build
  parses unchanged and a run frozen by this build is readable by an older one after the
  stripping the non-strict schema already does.
- No existing run changes. `intent_json` is written once at run creation and this phase does not
  rewrite it.
- If proposal B's commit merges first, step 2 lands in a `registry.ts` region it also edits.
  Resolve in favour of both: B's authorship guard runs before capture, this phase's opening-ask
  write happens inside capture.

## Tests and verification

- `test/workflow-run-intent-snapshot.test.ts`: a run whose session has been steered freezes the
  objective, not the steering prompt; the opening ask is preserved across an `amend`; a session
  with no objective still freezes its raw prompt; an opening request over `PROMPT_CAP` is stored
  and frozen as the clamped form rather than being truncated a second time or dropped.
- A new case pinning that the fingerprint is unchanged by the added fields.
- `test/session-goal*.test.ts` (or the nearest existing goal test): the opening prompt is written
  on the first accepted prompt and never overwritten, including across a `replace`.
- `test/workflow-runs-render.test.ts` and `test/workflow-runs-model.test.ts` for the new run
  detail shape.
- `e2e/specs/workflow-run-record-tabs.spec.ts` extended, or a new
  `e2e/specs/workflow-run-intent.spec.ts`, asserting that run detail shows the durable objective
  as the reviewed ask and the opening request beside it.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`,
  `npm run test:e2e`.

## Merge and exit criteria

- A run created in a steered session freezes and displays the durable objective.
- The opening ask survives an amendment and a replacement and is visible to Personas.
- Every pre-existing frozen run still reads back without becoming `unreadable`.
- All verification above passes and the pull request is merged.

## Downstream handoff

Phases 2 and 3 may rely on: `WorkflowRunIntentSnapshot.openingAsk` and `.intentSource`;
`session_goals.opening_prompt` as write-once and as the clamped opening prompt; `primaryGoal.rawPrompt` meaning "the durable
objective". They must not change `rawGoal`, `refinedGoal`, `decisions`, the fingerprint
derivation, or the write-once rule on the opening prompt.

## Cross-phase audit record

- Initial: no earlier phases to reconcile.
- Review round 1: the phase claimed a "verbatim" opening ask while the Goal pipeline clamps
  every prompt at `PROMPT_CAP`. Resolved in favour of the pipeline: the persisted value is the
  clamped opening prompt, stated in the findings, the steps, the tests and the downstream
  handoff, so no later phase inherits a promise the capture path cannot keep.
- Review round 2: the correction above was applied here but not to the source plan, which still
  promised a verbatim opening ask in both its Markdown and its rendering. `plan.md`, `plan.html`
  and the two `phased-plan` findings now use the same language this phase does, so the headline
  document and the phase responsible for building it make one claim rather than two.
