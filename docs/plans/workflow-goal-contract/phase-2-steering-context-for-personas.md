# Phase 2: Steering reaches Personas as steering

## Outcome and value

A Persona is told, separately from the acceptance contract, what the human has since asked for
about method, sequence or priority - and told plainly that it does not move the contract. A
session steered with "skip the E2E for now, the harness is broken" no longer reads as missing
evidence, and a session steered with "do the smaller one first" no longer reads as a narrowed
goal.

Phase 1 makes the contract durable, which is correct and which also removes steering from a
Persona's view entirely except as raw transcript. This phase gives it back in the shape a
reviewer can use, and it is what keeps Phase 1 from trading one class of unfair verdict for a
quieter one.

## Entry criteria and dependencies

- Direct prerequisite: Phase 1 merged.
- **Assumed upstream:** commit `a8610a7b` on task `fb317738`'s branch, which stops
  daemon-delivered text being captured as an accepted human prompt. If that has not merged when
  this phase starts, the steering log must enforce origin itself before persisting - a log of
  Foreman's packets presented to Personas as the human's steering is the same defect this plan
  exists to fix, arriving through a new door. Check before implementing.
- Inherits from Phase 1: `primaryGoal.rawPrompt` is the durable objective, and
  `WorkflowRunIntentSnapshot` carries `openingAsk` and `intentSource`.

## Scope and non-goals

In scope:

- A durable record of each classified steering instruction, written as the refiner decides it.
- A bounded `steering` field on the captured context, frozen with the run's intent.
- One clearly subordinate Persona prompt section, and its rendering in run detail.

Non-goals:

- No change to the classification itself, to the objective, or to the fingerprint.
- No steering-derived acceptance criteria. Steering is context for judgement, never a criterion:
  compaction's input stays `{rawGoal, refinedGoal, decisions}` exactly as today.
- No provenance verdict or badge (Phase 3).
- Steering is not a `WorkflowHumanDecision`. Decisions are answers a human gave to a question;
  conflating the two would put steering into the fingerprint and into criteria compaction.

## Repository findings and inherited contracts

- **Resolved steering is not retained.** `refiner.ts:424` writes
  `pendingPrompts: current.pendingPrompts.slice(1)` as each revision resolves, and only the
  newest `relationship`, `focus` and `rationale` survive on the row. A steering log has to be
  written at the moment of classification; it cannot be reconstructed later.
- The refiner's durable commit point is the `registry.upsertGoal` call that records the
  classification (`src/server/goal/refiner.ts:389` and `:410`). That call already runs under the
  compare-and-set that protects against a concurrent revision, so the log write belongs beside
  it rather than in a second poller.
- `pending_prompts` on `session_goals` (`src/server/db.ts:4146`) is the precedent for a JSON
  column of ordered revisions, and `db.ts:1100` names it as such. A separate table is preferred
  here because the log is append-only and unbounded in a long session, while `pending_prompts`
  is a short queue that drains.
- The Persona prompt's section order is `src/server/workflows/prompt.ts:64` onward: intent,
  published guidance, evidence contract, prior feedback, untrusted evidence, required output.
  Prior Persona feedback is already rendered as a labelled non-authoritative section
  (`prompt.ts:110`), which is the precedent this section follows.
- **Origin is the log's entry condition, and it is owned upstream.** `refine` classifies whatever
  reached `pendingPrompts`, and `HookSpec.promptText` carries no authorship, so before commit
  `a8610a7b` on task `fb317738`'s branch a daemon-delivered packet could be classified `steer`
  and would then be persisted here as the human's steering. That commit is what makes
  `pendingPrompts` human-only, by consulting the authorship record in `captureHookGoalPrompt`.
  `attributeWorkflowContextTranscript` (`src/server/workflows/context.ts:400`) protects
  transcript evidence and decisions only; it does not protect this log.
- `transaction` is local to `src/server/workflows/store.ts:2281` and is not reachable from the
  Goal pipeline, whose durable write is `upsertSessionGoal` (`src/server/db.ts:10204`). A
  combined writer therefore belongs in `db.ts` beside that function rather than in the registry
  or the refiner.
- `durableRunJson` (`src/server/workflows/store.ts:625`) refuses `intent_json` outright when the
  WHOLE serialized snapshot exceeds `WORKFLOW_EXECUTION_LIMITS.contextJsonBytes`. It does not
  truncate, and `WorkflowRunIntentSnapshotSchema` caps only individual fields, so a per-field
  bound on steering is not enough to keep run creation from throwing.

## Implementation steps

1. **Add the steering log.** A `session_goal_steering` table keyed by note key with the revision
   number, the bounded instruction text, the classified relationship, the refiner's rationale,
   and the timestamp, under `UNIQUE(note_key, revision)`. A revision is the durable ordering
   key here, not the timestamp: two revisions can resolve inside one millisecond, and the
   refiner already treats the revision number as the queue's identity. Create the table in
   `src/server/db.ts` beside the other session-keyed tables and prune it on the same sweep as
   `pruneGoals` (`src/server/goal/refiner.ts:150`), with the same live-key safety property.
2. **Write it where the verdict is made, atomically.** In `refine`
   (`src/server/goal/refiner.ts:339` onward), append one row for every resolved revision whose
   relationship is `steer`. The append and the `upsertGoal` that advances
   `resolvedPromptRevision` must be **one** `BEGIN IMMEDIATE` transaction in a combined `db.ts`
   writer, so a crash between them cannot leave a revision marked resolved with no steering
   recorded, or recorded twice. The unique constraint makes the insert idempotent, so a retry
   after an ambiguous failure is safe. A revision that resolves as `amend` or `replace` moves
   the objective and is not steering; an `unclear` one is not recorded, because the system has
   not decided what it is.
3. **Expose it to capture.** Add a registry reader for a session's steering, ordered and
   bounded by REVISION rather than by timestamp, bounded by count and by bytes the way
   `boundedDecisions` is (`src/server/workflows/context.ts:1005`).
4. **Freeze it with the run.** Add `steering: WorkflowSteeringNote[]` to
   `WorkflowRunIntentSnapshot` and its zod schema, populated in `readWorkflowIntentSnapshot`.
   The freeze cutoff is the goal row's `resolvedPromptRevision` read in the same call that reads
   the objective, and the snapshot records it: a revision classified after that read belongs to
   the next run, not this one, and recording the cutoff makes which is which checkable rather
   than inferred. Surface the field on the context snapshot beside `primaryGoal`, and exclude it
   from `workflowIntentFields` so the fingerprint is unchanged and no existing run becomes
   unreadable.
5. **Render it for Personas.** Add one section after the intent block in
   `src/server/workflows/prompt.ts`, stating that these are method, sequence and priority
   changes the human asked for after the contract was set, that they do not add, remove or
   narrow acceptance criteria, and that a Persona may rely on them when judging whether an
   expected step was legitimately skipped. Keep it above published Persona guidance and below
   the intent, matching the existing ordering rule that operator intent precedes guidance.
6. **Show it in run detail.** One disclosure beside the intent, listing each steering note with
   its revision and time. Reuse the existing disclosure component rather than adding a surface.
7. **Documentation.** Extend the intent paragraph in `docs/workflows.md:732` to describe
   steering as frozen context that is not a criterion.

## Data, migration and compatibility

- One additive table. No backfill: sessions that steered before it exists have no log, and a run
  frozen then carries an empty array, which renders as absent.
- The snapshot field is additive and optional, excluded from the fingerprint. Runs frozen by
  Phase 1 read back unchanged.
- **Steering takes the REMAINING snapshot budget, not a fixed one.** `durableRunJson` refuses
  `intent_json` when the whole serialized snapshot exceeds
  `WORKFLOW_EXECUTION_LIMITS.contextJsonBytes`, and `rawGoal`, `refinedGoal`, `openingAsk` and
  `decisions` are already sized independently, so a fixed per-field cap on steering can still
  push the row over and make run creation throw. Serialize the candidate snapshot without
  steering, spend what is left, and drop the oldest notes until it fits. A snapshot that cannot
  fit even one note carries none rather than failing the freeze: losing steering context is a
  worse review, while losing the run is no review at all.

## Tests and verification

- `test/goal-steering-log.test.ts`: a `steer` verdict appends exactly one row; `amend`,
  `replace` and `unclear` append none; a revision classified twice appends once; a failure
  between the goal update and the append leaves neither applied; two revisions resolving with
  identical timestamps are ordered and captured by revision.
- A test that a prompt the daemon delivered never reaches the log. This is the invariant
  `a8610a7b` establishes upstream, and it is pinned HERE as well, because this log is a second
  consumer of it and a regression there would be silent in this one.
- `test/workflow-run-intent-snapshot.test.ts`: the freeze carries the log, bounded; the
  fingerprint is identical with and without steering present; a snapshot whose other fields
  already fill the byte budget freezes with steering dropped rather than throwing.
- `test/workflow-persona-prompt.test.ts` (or the nearest existing prompt test): the steering
  section renders after intent and before published guidance, and is absent with no steering.
- `e2e/specs/workflow-run-steering.spec.ts`: a run whose session was steered shows the steering
  disclosure in run detail with the instruction text.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e`.

## Merge and exit criteria

- A steered session's run carries its steering, frozen, bounded and labelled.
- No steering text reaches criteria compaction, and the intent fingerprint is unchanged.
- A run with no steering renders and prompts exactly as it did after Phase 1.

## Downstream handoff

Nothing later depends on this phase. It owns the steering log, its capture field and its
Persona section; Phase 3 must not read or render them.

## Cross-phase audit record

- Review round 1: four corrections, none of which changes the approved behavior. The origin
  invariant moved from a passing remark in the findings to an explicit upstream dependency, an
  implementation condition and a test. The log write became atomic with the goal update under a
  unique constraint. Ordering and the freeze cutoff moved from timestamps to revisions, which
  is the key the refiner already treats as the queue's identity. Steering now takes the
  remaining snapshot byte budget rather than a fixed cap, because `durableRunJson` refuses the
  whole row rather than truncating a field.
- Reconciled against Phase 1: this phase adds only optional snapshot fields and does not touch
  `rawGoal`, `refinedGoal`, `decisions`, `openingAsk`, `intentSource`, or the fingerprint
  derivation Phase 1 pins. Phase 1's write-once rule on `session_goals.opening_prompt` is not
  affected; the steering log is a separate table.
- Dependency direction confirmed: this phase reads Phase 1's contract meaning and adds to it.
  Phase 1 does not read anything here.
