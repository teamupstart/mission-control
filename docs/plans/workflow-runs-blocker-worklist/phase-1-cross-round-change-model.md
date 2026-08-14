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

### 1. `requestedChangeKey(change: RequestedChange): string`

New exported function in `src/web/workflows/run-model.ts`.

- Normalize the title: lowercase, strip `` ` ``, `"`, `'`, `*`, `_`, collapse whitespace,
  trim trailing `.,;:!?`.
- Key is `` `${change.path ?? ""}\n${normalizedTitle}` ``.
- Deliberately excludes `line`, mirroring `marker.ts` for the reason its comment gives: the
  next edit moves the line, and a location-sensitive key re-raises every finding every round.
- Not hashed. `node:crypto` is unavailable in the browser bundle and a grouping key needs no
  digest. Carry a doc comment saying so, and cross-reference `marker.ts` so the next reader
  finds the prior art rather than assuming divergence is accidental.

### 2. `runChangeWorklist(detail: WorkflowRunDetail): ChangeWorklistRow[]`

New exported function and type in `run-model.ts`.

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
  state: "open" | "resolved";
}
```

Derivation, in order:

1. Fold submissions to one entry per round using the **same rule as
   `repeat-offender.ts`**: order by `round → segment → createdAt`, then keep each node's
   newest attempt within the round (highest segment, then highest `attempt`). Extract this as
   a small local helper so the correspondence is explicit and testable.
2. For each round, for each persona attempt whose verdict is `fail`, key every
   `requestedChanges[]` entry with `requestedChangeKey`.
3. Accumulate per key: `firstRound` = lowest round it appeared in; `lastRound` = highest.
   Keep the **newest** round's title, rationale, evidence, path, line, confidence and persona
   name, so a reviewer that sharpens its wording shows the current wording.
4. `state` is `"open"` when `lastRound === latestRound`, otherwise `"resolved"`.
5. `roundsOpen` counts the rounds from `firstRound` through `lastRound` **inclusive** in which
   the key appeared. Document whether it is a span or a count of appearances and make the test
   pin it; a change that lapses for a round and returns is the case that distinguishes them.
   Adopt **count of appearances**, so the number never claims a round the reviewer stayed
   silent in.
6. Sort: open before resolved; then `firstRound` ascending (oldest grievance first); then
   `nodeId`; then title. Stable and independent of map iteration order.

Read verdicts defensively, mirroring `normalizePersonaVerdict`'s intent: a row that fails to
parse is skipped, never crashes the page.

### 3. Unit tests

New file `test/workflow-change-worklist.test.ts`, using `node:test` and `node:assert/strict`.

Cases:

- Two rounds raising the same title at the same path produce **one** row with
  `firstRound: 1`, `roundsOpen: 2`, `state: "open"`.
- A change raised in rounds 1 and 2 but absent in round 3 is `state: "resolved"`,
  `lastRound: 2`.
- Title differing only by case, backticks, trailing period or collapsed whitespace is the
  **same** key.
- A different `line` on the same path and title is the **same** key.
- A different `path` with the same title is a **different** key.
- A change with **no path** keys and renders without crashing, and does not collide with a
  different pathless change.
- Two segments inside one round (a session action mid-round) count as **one** round, matching
  `repeat-offender.ts`. This is the regression that justifies the shared folding rule.
- A change that lapses in round 2 and returns in round 3 reports `roundsOpen: 2`, not 3.
- The newest round's wording wins when a title is sharpened but keys the same.
- An attempt with an unparseable verdict is skipped without throwing.

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

- `runChangeWorklist` and `requestedChangeKey` are exported from `run-model.ts` with doc
  comments that state the identity rule and cite `marker.ts` as prior art.
- Every unit test above passes, including the two-segments-one-round case.
- Typecheck, lint and the full unit suite are green.
- No file outside `src/web/workflows/run-model.ts` and `test/` is modified.
- The repository is operable: the new module is additive and unconsumed until Phase 2.

## Downstream handoff

Phase 2 may rely on:

- `runChangeWorklist(detail)` returning rows already sorted for display, so the view does no
  sorting of its own.
- `ChangeWorklistRow.key` being stable across renders and usable as a React key and as the
  selected-row identity.
- `state` partitioning the rows into the `Blocking` and `Archive` segments with no further
  filtering.
- `roundsOpen` being a count of appearances, not a span.

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
