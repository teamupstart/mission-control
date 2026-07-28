# Phase 3: The repeat-offender derivation

Part of `docs/plans/workflow-card-progress/phased-plan.md`. Source plan:
`docs/plans/workflow-card-progress/plan.md`, adopted decision 4. Source design: `mockups.html`,
Option C's one derivation, taken on the run detail only.

## Outcome

A repair loop that is burning tokens without converging says so. "The same member has failed N
rounds running" is currently invisible on every surface, and it is the signal that separates a
run making progress from one that will exhaust its rounds and block.

The mockups recommend taking this "regardless of which shape wins", and Option C's own note is
the argument: it "is the only option that surfaces a repair loop burning money without
converging, which is the failure mode that costs the most and is currently invisible until
someone opens the Runs page."

## Entry criteria and dependencies

- **Direct prerequisites: the planning session's pull request, and Phase 1.**
- Phase 1 supplies the failing stage's rung, which is where the sentence lands.
- **Concurrent with Phase 2.** Neither consumes anything the other owns.

## Scope

- A pure server-side derivation of consecutive per-member failure streaks.
- An **optional** field on `WorkflowRunDetail` carrying it.
- One line rendered on the failing stage's rung in the ladder.

### Non-goals

- **Nothing on `WorkflowRunSummary` and nothing on SSE.** This is adopted decision 4's explicit
  boundary: the summary is not widened, so Option D keeps its cleanest property. The chip, tile
  flag and rail mark are untouched.
- **No new table, column or migration.** The derivation reads rows that already exist.
- **No alerting.** This is a sentence on a reading surface, not a new `AlertKind`.
- **No change to how rounds are created or exhausted.**

## Repository findings

- `store.runDetail(id)` (`store.ts:3844-3881`) already loads `submissions` and `attempts` for the
  run, so the derivation needs no extra query.
- `compactGate` (`store.ts:119-130`) is the precedent for a small pure projection computed once
  in the store rather than in the browser, and it is where the source plan places this one.
- Rounds live on `WorkflowSubmission.round`, 1-based, with the initial submission at `round: 1`
  (`store.ts:2109`); `idx_workflow_submissions_round` is UNIQUE on `(run_id, round)`, so round
  numbers are dense and unambiguous.
- **Pass/fail is not the attempt state.** `WORKFLOW_NODE_ATTEMPT_STATES` is an infrastructure
  lifecycle only - `queued | running | retry_wait | completed | error | cancelled`
  (`workflow.ts:460-469`) - and the verdict is in `verdict_json`. `PersonaVerdict`
  (`:1260-1275`) is discriminated on `verdict: "pass" | "fail"`.
- **A parse failure is not a failure.** `parsePersonaVerdict` (`verdict.ts:112`) returns `null`
  on malformed JSON and the manager treats that as *infrastructure failure*, never a `fail`
  verdict. The derivation must do the same or an unparsable row inflates a streak.
- `latestAttemptsFor` (`run-model.ts:112`) is the browser's "newest attempt per node for one
  submission" rule; the server derivation must use the same rule per round, since a node can have
  several attempts in one round after an infrastructure retry.
- `PersonaSnapshot.name` (`workflow.ts:275-283`) is on the attempt's `persona`, so the member's
  display name is available without resolving the live Persona catalog - which is correct, since
  the version was published with that snapshot.
- Check nodes have no `PersonaVerdict`; their outcome is a `WorkflowCheckOutcome` in
  `output_json`. Whether checks participate is decided below.
- Tests touching the DB must set `HARNESS_HOME` before importing anything that resolves it
  (`db-isolation.test.ts` enforces `openDb`'s refusal under the test runner).

## Implementation steps

### 1. `src/shared/workflow.ts` - the wire type

`WorkflowRepeatOffender` is a **wire type and must be declared in the shared layer**, beside the
other run types:

```ts
export interface WorkflowRepeatOffender {
  nodeId: string;
  personaName: string;
  /** Consecutive most-recent rounds this member failed. Always >= 2. */
  rounds: number;
}
```

This is not a stylistic placement. It rides on `WorkflowRunDetail`, which is declared in this
same file and is read by the browser. `src/shared/` never imports from `src/server/` - it is
"wire types and zod schemas, imported via `@shared/*`" - so declaring the interface in the
server module and referencing it from `WorkflowRunDetail` would either leave the type unresolved
or invert the dependency boundary. The server derivation **imports** this type; it does not own
it.

Add the field to `WorkflowRunDetail` in the same file:

```ts
  /**
   * Members failing the most recent rounds consecutively. Detail-only and OPTIONAL: run
   * SUMMARIES travel over SSE for every run in the fleet and must stay compact, and an older
   * daemon serving a newer browser must not fail to parse.
   */
  repeatOffenders?: WorkflowRepeatOffender[];
```

Optionality is a cross-phase requirement, not a style choice: Phase 2 is concurrent and must
compile whether or not this has merged.

### 2. `src/server/workflows/repeat-offender.ts` (new) - the pure derivation

```ts
import type { WorkflowRepeatOffender } from "@shared/workflow.ts";

export function repeatOffenders(
  submissions: WorkflowSubmission[],
  attempts: WorkflowNodeAttempt[],
): WorkflowRepeatOffender[];
```

Rules, each of which is a way to get this wrong:

- **The streak is anchored at the latest round and runs backwards.** A member that failed rounds
  1 and 2 and passed round 3 is not a repeat offender; reporting it would be a claim that the
  loop is stuck when it has just converged. Walk rounds newest-first and stop at the first round
  the member did not fail.
- **A streak of 1 is not reported.** The minimum is 2, because "failed once" is what a repair
  round is *for*.
- **Per round, use the newest attempt per node**, matching `latestAttemptsFor`. An
  infrastructure retry inside one round is one round, not two.
- **Only a parsed `verdict: "fail"` counts.** A null or unparsable verdict is infrastructure and
  breaks the streak rather than extending it - the same rule `parsePersonaVerdict` already
  encodes.
- **Persona nodes only.** A check has no verdict, and a check that fails repeatedly is a
  different signal (a broken build, not a non-converging reviewer). Including it would put "the
  same member failed 3 rounds running" on a typecheck error, which is true and useless.
- **A round in which the member did not run at all breaks the streak**, because the claim is
  about consecutive *failures*, not about absence.

Placed in its own module rather than inline in `store.ts` so it is testable without a database.
`store.ts` imports `db.ts` transitively and therefore `node:sqlite`; a pure function behind a
`HARNESS_HOME` preamble is a test nobody will keep writing. The source plan's "beside
`compactGate`" is honoured in the sense that matters - it is a server-side projection computed
once, not a browser computation.

### 3. `src/server/workflows/store.ts`

Call `repeatOffenders(submissions, attempts)` in `runDetail` (`:3844-3881`) and put the result on
the returned detail. Omit the field entirely when the list is empty, so the common healthy case
adds nothing to the payload.

### 4. `src/web/workflows/WorkflowLadder.tsx`

On a **failed** stage's rung, under the existing `wf-ladder-why`, render one line per offender
whose `nodeId` belongs to that stage:

> Code Risk Reviewer has failed 3 rounds running.

Rendered from `detail.repeatOffenders`, guarded on the field being present. It is a
`wf-ladder-repeat` element, toned with the existing `--danger`-derived colour already used by
`wf-ladder-why`'s border.

### 5. `README.md`

One line in "Workflows and Personas": the ladder reports a member that has failed consecutive
repair rounds, which is what a non-converging repair loop looks like.

### 6. Tests

- `test/workflow-repeat-offender.test.ts` - a pure unit test over `repeatOffenders`, no DB and
  therefore no `HARNESS_HOME` preamble. Cases, one per rule above:
  - three consecutive failing rounds → `rounds: 3`;
  - failed, failed, **passed** (latest) → **not reported**, the regression that matters most;
  - one failing round → not reported;
  - two attempts in one round after an infrastructure retry → counts once;
  - an unparsable `verdict_json` → breaks the streak, never extends it;
  - a check node failing repeatedly → not reported;
  - a round the member did not run in → breaks the streak.
- `test/workflow-ladder-repeat.test.ts` - the ladder renders the sentence on the failing stage's
  rung, and renders nothing when the field is absent (proving an older daemon degrades quietly).

## Data, API and compatibility

- **No schema change, no migration, no new route, no SSE change.**
- The field is optional in both directions: a newer daemon serving an older browser sends a field
  it ignores; an older daemon serving a newer browser omits it and the ladder renders nothing.
- Payload cost is bounded by the number of persona nodes in one version and is omitted entirely
  when empty.

## Tests and verification

```
npm run typecheck
npm test
npm run build
```

Manual: drive a run so the same reviewer rejects twice in a row and confirm the line appears on
its stage; then let that reviewer pass and confirm the line disappears rather than persisting.

Visual evidence: [`phase-3-repeat-offender-evidence.png`](./phase-3-repeat-offender-evidence.png)
captures the shipped ladder component and stylesheet in both states. Round 3 shows
“Code Risk Reviewer has failed 3 rounds running.” on the failed stage; round 4 shows that
reviewer passing while the stage remains expanded for other findings, with the streak line
absent.

## Merge and exit criteria

- CI green on Node 24 and Node 26.
- A member failing consecutive latest rounds is reported; one that failed earlier and has since
  passed is not.
- `WorkflowRunSummary` and the SSE event pair are byte-for-byte unchanged - the check that
  adopted decision 4's boundary held.
- README updated in this same change.

## Downstream handoff

Nothing depends on this phase. It establishes:

- **`repeatOffenders` is detail-only.** A future surface that wants this on the collapsed card is
  making a new decision about widening the SSE summary, and should say so out loud rather than
  extending this field.
- **The streak is anchored at the latest round.** Any future consumer inherits that meaning.

## Cross-phase audit record

- Reconciled against Phase 1: this phase adds a rendered line inside the failing stage's rung,
  which Phase 1 draws, and adds no fetch - the field arrives on the detail
  `useWorkflowRunDetail` already loads. Phase 1's handoff rule that derivations live in
  `run-model.ts` is honoured in spirit and improved on: this derivation is server-side, so
  neither drawing can compute it differently.
- Reconciled against Phase 2 (concurrent): disjoint regions of `WorkflowLadder.tsx`,
  `styles.css` and `README.md`, as tabulated in the phased plan. The one hard requirement the
  concurrency creates is that `repeatOffenders` be **optional** on `WorkflowRunDetail`, so Phase
  2 compiles against either merge order. That is stated in step 2 and in the exit criteria.
- Reconciled against the source plan: adopted decision 4 said "run detail only", and the exit
  criteria make that testable by asserting the summary is unchanged rather than merely intending
  it.
- **Corrected after Inspector review of the planning PR (#308).** The first draft declared
  `WorkflowRepeatOffender` in `src/server/workflows/repeat-offender.ts` while adding the field to
  `WorkflowRunDetail` in `src/shared/workflow.ts`. Since `src/shared/` never imports from
  `src/server/`, that would have left the type unresolved or inverted the dependency boundary,
  and the phase would not have typechecked. The type is now declared in the shared layer and
  imported by the server derivation; the module split that makes the derivation testable without
  a database is unaffected.
