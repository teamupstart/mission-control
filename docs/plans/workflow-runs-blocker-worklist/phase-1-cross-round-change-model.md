# Phase 1: The cross-round requested-change model

## Outcome

`run-model.ts` gains the derivation the Blocker Worklist is built on: a single function that
walks every round of a run and returns one row per distinct requested change, carrying the
round it was first raised in, how many rounds it has been open, and whether it is still open.

No UI changes. The value delivered is a tested, reviewable answer to the one genuinely subtle
question in this work - *what makes two requested changes in two different rounds the same
change* - separated from the layout work that consumes it.

## Entry criteria and dependencies

- **Direct phase dependencies:** none. This is the first phase.
- Requires only what is already in `WorkflowRunDetail`. No server, schema or route work.

## Scope

- A change-identity key for `RequestedChange`.
- A cross-round worklist derivation over `WorkflowRunDetail`.
- Unit tests for both.

### Non-goals

- Any change under `src/web/workflows/WorkflowRuns.tsx` or `styles.css`.
- Any change to `src/shared/`, `src/server/`, routes, or the wire contract.
- Rendering anything. Phase 2 owns every pixel.
- Changing `repeat-offender.ts`. This phase *matches* its round-folding rule; it does not
  touch it.

## Repository findings

- `RequestedChange` (`src/shared/workflow.ts:2932-2938`) is `{ title, rationale, evidence,
  path?, line? }`. No id, no key, no fingerprint. The only React key today is positional:
  `` key={`${change.title}:${index}`} `` (`WorkflowRuns.tsx:411`).
- No helper in `run-model.ts` correlates verdict content across rounds. The cross-round
  helpers that exist (`inheritedAttempts`, `inheritedPasses`, `newestInheritedSource`,
  `continuationSourceAttempt`) all key on `nodeId` or on server-written pointers.
- `src/server/inspector/marker.ts:140` is the only finding-fingerprint in the repository. It
  hashes `path` + normalized title and documents *why* the line number is excluded. It is the
  design to mirror, but it imports `node:crypto` and belongs to the Inspector domain, so it is
  mirrored rather than lifted.
- `src/server/workflows/repeat-offender.ts` folds submissions to one row per round, keeping
  each node's newest attempt across that round's segments, before walking consecutive rounds.
  Its doc comment explains that walking submissions directly under-reports a streak.
- `verdictOf` (`run-model.ts:366`) is an unchecked cast: `attempt.verdict as unknown as
  PersonaVerdict | null`. The server-side equivalent used by `repeat-offender.ts` is
  `normalizePersonaVerdict`. Prefer the same defensive read here rather than trusting the cast
  over ten rounds of persisted rows.
- `orderedSubmissions` (`run-model.ts:128-130`) already sorts by `round → segment →
  createdAt`. Reuse it rather than re-sorting.

## Implementation steps

### 1. `requestedChangeKey(nodeId: string, change: RequestedChange): string`

New exported function in `src/web/workflows/run-model.ts`.

- Normalize the title: lowercase, strip `` ` ``, `"`, `'`, `*`, `_`, collapse whitespace,
  trim trailing `.,;:!?`.
- Key is `` `${nodeId}\n${change.path ?? ""}\n${normalizedTitle}` ``.
- Deliberately excludes `line`, mirroring `marker.ts` for the reason its comment gives: the
  next edit moves the line, and a location-sensitive key re-raises every finding every round.
- **Deliberately includes the owning `nodeId`, which is where this design stops mirroring
  `marker.ts`.** Only one Inspector raises findings on a pull request, so `path` plus title is
  a sufficient identity there. A run has several personas reviewing at once, and two can object
  about the same file in words that normalize identically. Without the node they fold into one
  row that carries a single `nodeId`, so the losing reviewer's evidence disappears and its
  objection becomes un-actionable - Phase 2 wires "Disable {persona}" and "Give this reviewer
  feedback" straight off the row's `nodeId`. A persona's node id is stable across rounds inside
  a run's immutable version, so this costs the cross-round matching nothing.
- Not hashed. `node:crypto` is unavailable in the browser bundle and a grouping key needs no
  digest. Carry a doc comment saying so, and cross-reference `marker.ts` so the next reader
  finds the prior art - and state the author divergence there, so it reads as a decision rather
  than as drift.

### 2. `runChangeWorklist(detail, asOfRound): ChangeWorklistRow[]`

```ts
export function runChangeWorklist(
  detail: WorkflowRunDetail,
  /** The round the reader is looking at. Null means the latest submission's round. */
  asOfRound: number | null,
): ChangeWorklistRow[]
```

New exported function and type in `run-model.ts`.

**The `asOfRound` parameter is not optional decoration; it is what keeps the section coherent
with the round scrubber above it.** The rest of the reader pane is round-scoped: `reviewAttempts`
is built from `detail.attempts.filter(a => a.submissionId === viewed?.id)`
(`WorkflowRuns.tsx:563`), so it shows only the round the scrubber points at. A whole-run worklist
beside it would put three counts on one segmented control that describe three different moments -
scrub to round 3 and `Passed` follows you while `Blocking` stays on round 10. Every row this
function returns is therefore the run **as it stood at the end of `asOfRound`**.

```ts
export interface ChangeWorklistRow {
  key: string;
  title: string;
  rationale: string;
  path: string | null;
  line: number | null;
  evidence: EvidenceRef[];
  nodeId: string;
  personaName: string | null;
  confidence: number | null;
  firstRound: number;
  lastRound: number;
  roundsOpen: number;
  state: "open" | "resolved" | "unconfirmed";
}
```

Derivation, in order:

1. Fold submissions to one entry per round using the **same rule as
   `repeat-offender.ts`**: order by `round → segment → createdAt`, then keep each node's
   newest attempt within the round (highest segment, then highest `attempt`). Extract this as
   a small local helper so the correspondence is explicit and testable.
1b. **Truncate to the window.** Resolve `horizon` = `asOfRound ?? the latest submission's
   round`, then discard every round above it. Nothing after this step may read a later round: a
   row that knows the future is exactly the incoherence this parameter exists to prevent.

   The default is **the latest submission's round, whether or not it has produced any attempt
   yet** - the same `ordered[0].round` that `repeat-offender.ts` anchors on, where `ordered` is
   submissions sorted by `round → segment → createdAt`, descending.

   Do **not** define it as "the newest round that has attempt data". That reads
   `attemptsByRound.get(latest.round)` in `repeat-offender.ts:64-65` as a fallback when it is a
   **bail-out**: that module returns `[]` outright when the newest round has no attempts, it
   does not step back to an older round. A fallback default would make `runStalemates(detail,
   null)` report a stalemate for a round that is not the one being viewed, at exactly the moment
   a new round opens and Stage 1 has not run yet - while `detail.repeatOffenders` says `[]`.
   That breaks the parity this file, `phase-2` and `phased-plan.md` all claim.
2. For each round in the window, for each persona attempt whose verdict is `fail`, key every
   `requestedChanges[]` entry with `requestedChangeKey(attempt.nodeId, change)`. Because the
   node is in the key, a row can only ever accumulate from one persona, and `nodeId` /
   `personaName` on the row are facts rather than last-writer-wins.
3. Accumulate per key: `firstRound` = lowest round it appeared in; `lastRound` = highest.
   Keep the **newest** round's title, rationale, evidence, path, line, confidence and persona
   name, so a reviewer that sharpens its wording shows the current wording.
4. `state` is resolved **per owning persona, never against a global round number**. A change
   is `"resolved"` only when its own `nodeId` has a completed attempt in some round later than
   `lastRound` and did not re-raise the key in it. Otherwise it is `"open"`.

   This is the trap in the obvious formulation. `state = lastRound === latestRound ? "open" :
   "resolved"` is wrong the moment a round is partially evaluated: Stage 3 personas do not
   finish together, so while round 10 is in flight Code Risk can have posted its fail before
   Test Evidence has run at all. Every change owned by a persona that has not re-attempted yet
   still has `lastRound = 9`, reads as `"resolved"`, and drops into Archive - not because the
   issue is gone but because nobody has looked yet. That is precisely the question the worklist
   exists to answer, answered backwards.

   `repeat-offender.ts` avoids this by construction rather than by a special case: its
   candidate set is `latestAttempts.values()`, so a node with no attempt in the latest round is
   simply absent from the result and is never reported as having recovered. Mirror that
   posture. Where it has no answer yet, say nothing rather than say "resolved".

   The comparison round is `horizon` from step 1b, never the run's newest round. Viewed as of
   round 4, a change that its persona re-raised in round 4 is `"open"` even if that persona
   dropped it in round 5 - because at round 4 it was open, and that is what the reader asked to
   see. Resolution is still decided per owning `nodeId` **within the window**.

4b. **Split "stopped appearing" into two outcomes - but only once the owning node has spoken
   again.** For a key that is no longer being raised, look at what its owning node did in the
   rounds after `lastRound`, inside the window:

   - the node has **no completed attempt** in any later round: `"open"`. Step 4's baseline wins
     and this split does not apply at all. The reviewer has not re-run, so "stopped appearing"
     is an artefact of nobody having looked yet, not an observation about the change.
   - the node **passed** in a later round: `"resolved"`. The reviewer said so.
   - the node completed a later round and **never passed**: `"unconfirmed"`. It looked, and did
     not confirm.

   The first bullet is the precondition, and it is not decoration: without it "never passed in a
   later round" is literally true of a node that never ran a later round, which would label an
   in-flight change `"unconfirmed"` - claiming the reviewer looked and withheld confirmation when
   it has not looked at all. That is the same partial-round error step 4 exists to prevent, and
   the Partial-round test case pins the opposite outcome. Read together, the rule is: no later
   attempt means `"open"`; a later attempt means the pass/never-passed split decides.

   `"unconfirmed"` asserts only what the data supports. It is tempting to call this case
   `superseded` and say the reviewer rephrased, and that is wrong: a reviewer that stops raising
   A **because A is fixed** while separately raising unrelated C is indistinguishable, from the
   outside, from one that reworded A into C. Both leave key A absent and the node still failing.
   Title-based identity cannot separate them, so the state says the reviewer never passed and
   the change was never confirmed fixed, and Phase 2 words it that way.

   An evidence-or-path heuristic - mark it rephrased only if the later failure shares a path or
   evidence with the dropped key - was considered and rejected. Two genuinely different findings
   in one file collide under it, so it converts a known unknown into a confident wrong answer,
   which is worse than the honest label on a surface whose whole purpose is telling an operator
   what is actually true.

   Without this split the rail contradicts itself. The stalemate card at its foot comes from
   `repeat-offender.ts`, which keys on `nodeId` and pass/fail and never reads a title, so a
   reworded finding produces an Archive row reading *"Resolved in round 5"* directly above a card
   reading *"Test Evidence Auditor has failed 10 rounds running"*. Same reviewer, same rail,
   opposite claims. Duplicating the round-folding rule was justified in this document by exactly
   that argument, so this case does not get to be the exception.

   Derive it here, from the folded rounds this function already walks. **Do not read
   `detail.repeatOffenders` for it.** That signal is anchored at the run's latest submission and
   thresholded at `rounds >= 2` for alerting, neither of which is right for a per-key,
   per-window question - and reading it would make this model depend on a value the `asOfRound`
   window cannot re-scope.
5. `roundsOpen` counts the rounds from `firstRound` through `lastRound` **inclusive** in which
   the key appeared. Document whether it is a span or a count of appearances and make the test
   pin it; a change that lapses for a round and returns is the case that distinguishes them.
   Adopt **count of appearances**, so the number never claims a round the reviewer stayed
   silent in.
6. Sort: `open`, then `unconfirmed`, then `resolved` - descending by how much the reader still
   has to care, which puts the unconfirmed ones at the top of Archive rather than buried under
   things that genuinely went away. Then `firstRound` ascending (oldest grievance first); then
   `nodeId`; then title. Stable and independent of map iteration order.

Read verdicts defensively, mirroring `normalizePersonaVerdict`'s intent: a row that fails to
parse is skipped, never crashes the page.

### 3. `runStalemates(detail, asOfRound): WorklistStalemate[]`

```ts
export interface WorklistStalemate {
  nodeId: string;
  personaName: string;
  /** Consecutive rounds this member failed, ending at the window's horizon. Always >= 2. */
  rounds: number;
}
```

The windowed twin of `repeat-offender.ts`, sharing the fold helper from step 1 and the horizon
from step 1b. Same rule - candidates are the nodes failing at the horizon, walk back while each
keeps failing, keep those with `rounds >= 2` - so the sentence it feeds means exactly what the
ladder's means.

**Including the bail-out.** When the horizon round carries no folded attempts, return `[]`, the
way `repeat-offender.ts:64-65` does rather than stepping back to an older round. This is what
makes the parity claim below true at the default window, and it is the one behaviour most likely
to be "helpfully" improved into a fallback by someone who has not read that guard.

It has a visible consequence worth stating rather than discovering: when a new round opens, the
stalemate card disappears until that round produces its first attempt, then comes back. That
flicker already exists on the ladder, which renders the same signal from the same anchor.
Matching it is the point - a card that persisted here while vanishing there would be two
surfaces disagreeing about one fact, which is the failure this whole design keeps circling.

**Why this exists rather than rendering `detail.repeatOffenders`.** That field is computed by
`store.ts` from the run's whole submission list and anchored on its newest one, so it is always
"as of the latest round" and this window cannot re-scope it. Rendered directly under a worklist
scrubbed to round 4, it would say "failed 10 rounds running" - a fact six rounds in the reader's
future, on the one rail this design keeps insisting must not contradict itself. Step 4b already
records that anchor as the reason `unconfirmed` is derived here; this is the same reason reaching
the same conclusion for the card.

The duplication is deliberate and bounded, on the same grounds as the fold rule: the server
module cannot enter the browser bundle, and the server has no reason to compute a windowed
variant. Pin them against each other - at the default window the output must equal
`detail.repeatOffenders`.

### 4. Unit tests

New file `test/workflow-change-worklist.test.ts`, using `node:test` and `node:assert/strict`.

Cases:

- Two rounds raising the same title at the same path produce **one** row with
  `firstRound: 1`, `roundsOpen: 2`, `state: "open"`.
- A change raised in rounds 1 and 2, absent in round 3, whose persona **passed** in round 3, is
  `state: "resolved"`, `lastRound: 2`.
- **Reworded finding.** A persona raises title A in rounds 1 to 5, then raises title B in rounds
  6 to 10 and never passes. Key A is `"unconfirmed"`, not `"resolved"`; key B is `"open"`. This is
  the case that would otherwise put "Resolved in round 5" on the same rail as "failed 10 rounds
  running" for one reviewer.
- **No later attempt is `"open"`, not `"unconfirmed"`.** A change last raised in round 2 whose
  persona has not run in round 3 at all stays `"open"`. This is the same fixture as the
  Partial-round case above, asserted against the *third* state rather than against `"resolved"`,
  because step 4b's split is the other way this can go wrong.
- **A persona that fixes one thing and raises another.** It raises key A in rounds 1 and 2, then
  in round 3 stops raising A and raises unrelated key C. Key A is `"unconfirmed"` - correct,
  because nothing here proves A was fixed - and the row must not be worded as though A was
  rephrased into C. This is the case that makes the state name a claim about knowledge rather
  than a claim about the reviewer's intent.
- An unconfirmed row and the `repeatOffenders` entry for its node never disagree: any node still
  reported as a repeat offender has every one of its stopped keys marked `"unconfirmed"`, never
  `"resolved"`. Assert this against a fixture that also produces a `repeatOffenders` entry, so
  the two derivations are pinned against each other rather than separately.
- Title differing only by case, backticks, trailing period or collapsed whitespace is the
  **same** key.
- A different `line` on the same path and title is the **same** key.
- A different `path` with the same title is a **different** key.
- **Two personas, one colliding title, same file.** Reviewer A and reviewer B both raise a
  change whose title normalizes identically on the same path. The result is **two rows**, each
  carrying its own `nodeId`, `personaName`, `rationale` and `evidence`. Neither reviewer's
  objection is dropped and neither becomes un-actionable. This is the case the `marker.ts`
  design cannot have and this one can.
- One persona resolving such a colliding change while the other still raises it leaves the
  other's row `"open"`, because resolution is per owning node and the rows never merged.
- A change with **no path** keys and renders without crashing, and does not collide with a
  different pathless change.
- Two segments inside one round (a session action mid-round) count as **one** round, matching
  `repeat-offender.ts`. This is the regression that justifies the shared folding rule.
- A change that lapses in round 2 and returns in round 3 reports `roundsOpen: 2`, not 3.
- The newest round's wording wins when a title is sharpened but keys the same.
- An attempt with an unparseable verdict is skipped without throwing.
- **`runStalemates` at the default window equals `detail.repeatOffenders`.** Build one fixture
  that produces offenders and assert the two derivations agree element for element. This is the
  guard against the browser twin and the server original drifting apart.
- `runStalemates(detail, 4)` on a 10-round run counts only up to round 4, and reports nothing for
  a node whose failing streak had not yet reached two rounds by then.
- A node failing at the horizon but passing the round before it is not a stalemate
  (`rounds >= 2`).
- **Partial round, the regression this model exists to avoid.** Round 3 is in flight: persona A
  has posted a fail, persona B has no attempt in round 3 at all. A's change is `"open"`. B's
  change from round 2 is **also `"open"`**, not `"resolved"` - B has not re-checked it.
- A change becomes `"resolved"` only once its **own** persona completes a later round without
  re-raising it, not merely because some other persona advanced the round.
- A latest round carrying no folded attempt data at all leaves every prior change `"open"`
  rather than resolving the entire worklist at once.
- **The just-opened round, which is where the two anchors could drift.** The newest submission's
  round exists but has produced no attempt yet. `runStalemates(detail, null)` returns `[]`,
  matching `detail.repeatOffenders`, rather than stepping back to the previous round and
  reporting a stalemate for a round nobody is viewing. `runChangeWorklist(detail, null)` still
  reports the previous round's changes as `"open"`, because per-node resolution needs a later
  attempt from the owning node and there is none.
- **As-of scoping.** A change raised in rounds 1 to 4 and dropped by its persona in round 5:
  called with `asOfRound: 4` it is `"open"` with `roundsOpen: 4`; called with `asOfRound: 5` or
  `null` it is `"resolved"`. The same detail payload, two honest answers.
- `asOfRound` above the newest round with data behaves exactly like `null` rather than
  returning an empty list.
- `asOfRound` below `firstRound` for every change returns an empty list, not a crash.

Run: `node --test --import tsx test/workflow-change-worklist.test.ts`

## Data, API and migration

None. This phase adds no persisted state, no route, no wire field. It reads
`WorkflowRunDetail` as it already arrives.

## Verification

```sh
node --test --import tsx test/workflow-change-worklist.test.ts
npm run typecheck
npm run lint
npm test
```

`npm run build`, `npm run smoke` and `npm run test:e2e` are not required: this phase changes
no runtime surface and no UI.

## Merge and exit criteria

- `requestedChangeKey`, `runChangeWorklist` and `runStalemates` are exported from `run-model.ts`
  with doc comments that state the identity rule, cite `marker.ts` as prior art, and say why the
  stalemate signal is derived here rather than read from `detail.repeatOffenders`.
- `runStalemates` at the default window equals `detail.repeatOffenders`, asserted against a
  fixture rather than assumed.
- Every unit test above passes, including the two-segments-one-round case and the partial-round
  case.
- No change is ever reported `"resolved"` on the strength of another persona having advanced
  the round. Resolution is per owning `nodeId`.
- Typecheck, lint and the full unit suite are green.
- No file outside `src/web/workflows/run-model.ts` and `test/` is modified.
- The repository is operable: the new module is additive and unconsumed until Phase 2.

## Downstream handoff

Phase 2 may rely on:

- `runChangeWorklist(detail, asOfRound)` returning rows already sorted for display, so the view
  does no sorting of its own.
- `ChangeWorklistRow.key` being stable across renders and usable as a React key and as the
  selected-row identity. It **includes the owning `nodeId`**, so a row's `nodeId` and
  `personaName` always name the reviewer that actually raised it, and two reviewers raising
  colliding titles produce two rows rather than one. Phase 2 can wire "Disable {persona}" and
  the directive editor straight off the row.
- `state` partitioning the rows: `"open"` is `Blocking`, `"resolved"` and `"unconfirmed"` are
  both `Archive`, with no further filtering. The two Archive states are distinguished only so
  Phase 2 can label them honestly - a `"unconfirmed"` row must never be worded as though its
  reviewer became satisfied.
- `state` being **conservative under a partial round**: a change whose persona has not
  re-attempted stays `"open"`. Phase 2 never has to ask whether a round finished before
  trusting the partition.
- `roundsOpen` being a count of appearances, not a span.
- **Every row being scoped to the round Phase 2 asked for.** Passing the viewed submission's
  round makes the worklist describe the same moment as the round-scoped `reviewAttempts` beside
  it, so the segmented control's three counts always agree. Phase 2 does no windowing of its
  own.
- `runStalemates(detail, asOfRound)` answering the stalemate question **for the same window**, so
  the card at the foot of the rail describes the viewed round like everything above it. Phase 2
  renders this and **not** `detail.repeatOffenders`, which is latest-anchored and cannot be
  re-scoped.

The boundary of this model, stated so Phase 2 does not wait for something that is not coming:
it covers **requested changes only**. Check outcomes and passing reviewers are not rows here
and never will be - they carry no requested change, and folding them in would turn a change
model into a view model. Phase 2 keeps the existing `reviewerAttempts` / `checkOutcomeOf` path
for its `Passed` segment.

Phase 2 must not:

- Recompute change identity by any other rule, or key rows positionally.
- Re-sort the rows.
- Change the round-folding rule without also changing `repeat-offender.ts`, since the stalemate
  card and the worklist must agree on what a round is.

## Cross-phase audit record

- **Initial write.** No earlier phases to reconcile against.
- Checked against `src/server/workflows/repeat-offender.ts`: the round-folding rule is
  duplicated deliberately rather than imported, because that module is server-side and this one
  must stay in the browser bundle. The duplication is recorded here and in the test that pins
  the two-segments case, so a future change to one is visibly a change to both.
- Checked against `test/workflow-repeat-offender.test.ts`: that suite asserts `repeatOffenders`
  never enters `WorkflowRunSummary` or the `ServerEvent` union. This phase adds no wire field,
  so that guard is unaffected.
- **Reconciled after writing Phase 2.** Phase 2 found that the section it replaces also renders
  check outcomes and three empty-state sentences carrying no requested change. The decision was
  to keep this model narrow rather than widen it, and the boundary now lives in this phase's
  downstream handoff, which is the earliest place that must own it. No scope or signature here
  changed.
- **Inspector round 8, `major`, accepted.** Step 4b's two-way split had no precondition, so
  "never passed in a later round" was literally true of a node that never *ran* a later round -
  labelling an in-flight change `"unconfirmed"`, which claims the reviewer looked and withheld
  confirmation. Step 4 and the Partial-round test case both require `"open"` there, so the
  document contradicted itself: 4b was written in round 6 against a two-state world and never
  reconciled with the partial-round precondition added in round 1. 4b is now a three-way rule
  with "no completed later attempt" first, and a test case pins that outcome against the third
  state specifically rather than only against `"resolved"`. Also fixed a sentence the round-6
  rename had corrupted into nonsense - "tempting to call this case `unconfirmed`" now reads
  `superseded`, which is what it meant.
- **Inspector round 7, `major`, accepted.** Step 1b defaulted the horizon to "the newest round
  carrying folded attempt data", which misread `repeat-offender.ts:64-65`: that line is a
  **bail-out** returning `[]`, not a fallback stepping back to an older round. The two anchors
  therefore diverged exactly when a new round opens before Stage 1 runs - `repeatOffenders` says
  `[]` while `runStalemates(detail, null)` would have reported a stalemate from the previous
  round - contradicting the parity criterion this file states and `phase-2` and `phased-plan.md`
  repeat. Default is now the latest submission's round unconditionally, and `runStalemates`
  carries the same bail-out. The resulting flicker when a round opens is named in step 3 rather
  than left to be discovered and "fixed" back into a fallback. Note the shape of the error: the
  citation was accurate and the reading of it was not, which is a failure mode that survives
  spot-checking line numbers.
- **Inspector round 6, `major`, accepted.** The third state was called `superseded` and asserted
  the finding had been rephrased. Step 4b decided it purely from whether the owning node failed
  again for **any** reason, so a reviewer that stops raising A *because A is fixed* while
  separately raising unrelated C landed in it - and Phase 2 then told that operator their fix had
  merely been reworded. Renamed `unconfirmed`, and the semantics narrowed to what the data
  supports: the reviewer never passed, so nothing is known. The two cases are genuinely
  indistinguishable under title-based identity, and an evidence-or-path heuristic to separate
  them was considered and rejected - two different findings in one file collide under it, trading
  a known unknown for a confident wrong answer. New test case: a persona that resolves one
  finding while raising an unrelated new one in the same round.
- **Inspector round 5, `major`, accepted.** The round-4 entry below records that
  `repeatOffenders`' latest-submission anchor is wrong for a windowed question and that
  `asOfRound` cannot re-scope it - and then that observation was used only to justify deriving
  `unconfirmed` here, never applied to the stalemate card, which Phase 2 still rendered straight
  from the unscoped field. Scrubbed to round 4 of a 10-round run, the card would have read
  "failed 10 rounds running" under segments describing round 4. Adds `runStalemates(detail,
  asOfRound)`, the windowed twin of `repeat-offender.ts`, sharing this file's fold helper and
  horizon. Pinned against `detail.repeatOffenders` at the default window so the browser twin and
  the server original cannot drift. The lesson is narrower than the fix: a reason written down in
  an audit record is not the same as a reason applied everywhere it reaches.
- **Inspector round 4, `minor`, accepted.** A reviewer that rewords a title it keeps raising
  produced a `"resolved"` row for the old key, which would sit on the same rail as a stalemate
  card saying that reviewer has failed every round - the exact on-screen disagreement this file
  cites to justify sharing the round-folding rule, left as an exception to it. Dismissing it as
  "the same trade-off `marker.ts` makes" did not hold either: `marker.ts` has no adjacent
  title-independent signal to contradict. `state` gains a third value, `"unconfirmed"`, derived
  in step 4b from the folded rounds this function already walks. Deliberately **not** read from
  `detail.repeatOffenders`, whose latest-submission anchor and `rounds >= 2` alerting threshold
  are both wrong for a per-key, per-window question, and which the `asOfRound` window cannot
  re-scope. Three test cases, one of which pins this derivation against a fixture that also
  produces a `repeatOffenders` entry so the two cannot drift apart.
- **Inspector round 3, `major`, accepted.** `requestedChangeKey` took only the change, so its
  identity was `path` plus normalized title - which is where mirroring `marker.ts` stopped being
  right and nobody had noticed, including me. That module has exactly one author, so it cannot
  suffer a cross-author collision; a run has several personas reviewing at once. Two reviewers
  objecting about one file in identically-normalizing words would have folded into a single row
  keeping one `nodeId`, silently dropping the other's evidence and making its objection
  un-actionable, because Phase 2 wires the disable and directive actions off the row's node. The
  key now takes `nodeId` as its first component. Cross-round matching is unaffected: a persona's
  node id is stable inside a run's immutable version, so the node only ever prevents
  cross-reviewer merging. Two test cases added, and the divergence from `marker.ts` is now
  stated in the doc comment so it reads as a decision rather than drift.
- **Inspector round 2, `major`, accepted.** The function was whole-run and took only `detail`,
  while the `reviewAttempts` derivation Phase 2 keeps for its `Passed` segment is scoped to the
  scrubber's viewed submission. Scrubbing to round 3 would have left `Blocking` and `Archive`
  describing round 10 while `Passed` described round 3 - three counts on one segmented control,
  three different moments. Signature is now `runChangeWorklist(detail, asOfRound)` with a
  truncation step, so the rows and the segment beside them always describe one round. Three
  test cases added. This is a **breaking signature change against the version Phase 2 was
  written on**, and Phase 2's step 1 was updated in the same commit; the alternative - widening
  Phase 2 to re-window rows it did not compute - would have split one rule across two phases.
- **Inspector round 1, `major`, accepted.** Step 4 originally read `state = lastRound ===
  latestRound ? "open" : "resolved"`, which marks a change resolved whenever any *other*
  persona advances the round, because Stage 3 personas do not finish together. Rewritten to
  resolve per owning `nodeId`, mirroring `repeat-offender.ts`'s candidate-set posture rather
  than adding a special case, with three new test cases and a new exit criterion. Phase 2 was
  re-checked and needs no change: it consumes `state` as an opaque partition, and the contract
  it relies on got strictly stronger.
