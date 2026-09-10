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
- The workflow already excludes its own delivered packets from human-authored transcript
  material (`attributeWorkflowContextTranscript`, `src/server/workflows/context.ts:400`). The
  steering log must inherit the same exclusion: an instruction the daemon typed is not steering.

## Implementation steps

1. **Add the steering log.** A `session_goal_steering` table keyed by note key with the revision
   number, the bounded instruction text, the classified relationship, the refiner's rationale,
   and the timestamp. Create it in `src/server/db.ts` beside the other session-keyed tables and
   prune it on the same sweep as `pruneGoals` (`src/server/goal/refiner.ts:150`), with the same
   live-key safety property.
2. **Write it where the verdict is made.** In `refine`
   (`src/server/goal/refiner.ts:339` onward), append one row for every resolved revision whose
   relationship is `steer`, in the same durable step that advances
   `resolvedPromptRevision`. A revision that resolves as `amend` or `replace` moves the
   objective and is not steering; an `unclear` one is not recorded, because the system has not
   decided what it is.
3. **Expose it to capture.** Add a registry reader for a session's steering since a given
   timestamp, bounded by count and by bytes the way `boundedDecisions` is
   (`src/server/workflows/context.ts:1005`).
4. **Freeze it with the run.** Add `steering: WorkflowSteeringNote[]` to
   `WorkflowRunIntentSnapshot` and its zod schema, populated in `readWorkflowIntentSnapshot`
   from the session's log at freeze time, and surfaced on the context snapshot beside
   `primaryGoal`. Excluded from `workflowIntentFields`, so the fingerprint is unchanged and no
   existing run becomes unreadable.
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
- Bounded on write and again on freeze, so a long-running session cannot grow a snapshot past
  `WORKFLOW_EXECUTION_LIMITS.contextJsonBytes` (`src/server/workflows/store.ts:625` refuses the
  row rather than truncating it, so the bound has to hold before that check).

## Tests and verification

- `test/goal-steering-log.test.ts`: a `steer` verdict appends exactly one row; `amend`,
  `replace` and `unclear` append none; a revision classified twice appends once.
- `test/workflow-run-intent-snapshot.test.ts`: the freeze carries the log, bounded; the
  fingerprint is identical with and without steering present.
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

- Reconciled against Phase 1: this phase adds only optional snapshot fields and does not touch
  `rawGoal`, `refinedGoal`, `decisions`, `openingAsk`, `intentSource`, or the fingerprint
  derivation Phase 1 pins. Phase 1's write-once rule on `session_goals.opening_prompt` is not
  affected; the steering log is a separate table.
- Dependency direction confirmed: this phase reads Phase 1's contract meaning and adds to it.
  Phase 1 does not read anything here.
