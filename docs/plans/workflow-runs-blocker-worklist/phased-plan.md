# Phased plan: the Blocker Worklist

## Source

- Approved plan: [`plan.md`](plan.md)
- Design comparison the selection came from:
  [`docs/reports/workflow-runs-triage-mockups/report.html`](../../reports/workflow-runs-triage-mockups/report.html)

## Incorporated human decisions

| Decision | Selection | Where it lands |
| --- | --- | --- |
| Which of six mockups | **B, Blocker Worklist** | Phase 2 |
| Stage pipeline, run header, round scrubber | **Keep unchanged** | Non-goal in both phases |
| Run rail and filters | **Keep unchanged** | Non-goal in both phases |
| Next step | **Phase it and schedule the work** | This document |

## What the investigation changed

The repository disagreed with the mockup in four places. Each is recorded in `plan.md` with
its evidence; the phases implement the adopted position, not the drawing.

1. **A requested change has no identity.** `RequestedChange` carries no id and nothing in the
   codebase correlates verdict content across rounds. "Open since round 4" has to be derived,
   and that derivation is the entire reason this is two phases rather than one.
2. **A round is not a submission.** A session action splits one round into several evidence
   segments. `repeat-offender.ts` already folds for this and documents why; the worklist reuses
   the rule so the rail and the stalemate card cannot disagree on one screen.
3. **Not every change has a path.** The type makes it optional and the e2e fail fixture emits
   none. The mockup drew a file on every row.
4. **Sub-run selection is not routed.** The selected round is local state and there is no
   precedent for a sub-run selection in `MissionRoute`. Selection follows that precedent, which
   removes all route work - and with it the `App.tsx` `onFilters` hazard that silently drops
   unspread route fields.

The last of these is why there is no route phase. The first is why there is a model phase.

## Phases

| Phase | Name | Depends on | Delivers |
| --- | --- | --- | --- |
| 1 | [Cross-round change model](phase-1-cross-round-change-model.md) | none | `requestedChangeKey` and `runChangeWorklist` in `run-model.ts`, with unit tests |
| 2 | [Blocker Worklist reader pane](phase-2-blocker-worklist-reader.md) | Phase 1 | The worklist UI, the stalemate card, styles, and e2e coverage |

## Dependency graph

```
Phase 1  ──▶  Phase 2
```

## Concurrency

None. Phase 2 consumes Phase 1's exports, so the two are strictly ordered. Merge order is
Phase 1 then Phase 2.

## Why two phases and not one

The change-identity rule is the only genuinely subtle decision in this work: a key that
includes the line number re-raises every finding on every edit, and a key over the raw title
splits on a reworded sentence. It deserves review on its own, with unit tests that pin the
edge cases, rather than review buried inside a several-hundred-line layout change.

Phase 1 is additive and unconsumed until Phase 2 merges. That is a deliberate, bounded
trade: a pure module with a full unit suite is the repository's normal shape for a
foundational interface, and it leaves the tree operable and green at the merge boundary.

## Cross-phase contracts

- **The stalemate card is windowed too.** Phase 2 renders `runStalemates(detail, asOfRound)`,
  not `detail.repeatOffenders`, which is computed over the whole run and anchored on its newest
  submission. Nothing in the rail may state a fact from a round later than the one being viewed.
- **The worklist is windowed by the viewed round.** `runChangeWorklist(detail, asOfRound)`
  returns the run as it stood at the end of that round, and Phase 2 passes the round scrubber's
  current submission. The rest of the reader pane is already round-scoped, so a whole-run
  worklist beside it would put three counts from two different moments on one segmented
  control. Phase 2 does no windowing of its own.
- `ChangeWorklistRow.key` is stable across renders and is both the React key and the
  selected-row identity. Phase 2 must not key rows positionally.
- **The key includes the owning persona node.** A row's `nodeId` and `personaName` always name
  the reviewer that raised it, so two reviewers asking for the same thing produce two rows.
  Phase 2 wires the per-row actions off that node and must not dedupe the rows in the view.
- Rows arrive **pre-sorted** (`open`, then `unconfirmed`, then `resolved`, then oldest first).
  Phase 2 does not re-sort.
- `state` alone partitions the segments - `open` is `Blocking`, `resolved` and `unconfirmed` are
  both `Archive` - and is **conservative under a partial round**: resolution is decided per
  owning persona, so a change whose reviewer has not re-attempted stays `open` rather than
  reading as fixed because some other reviewer advanced the round.
- **A key that stops appearing while its persona never passes is `unconfirmed`, not `resolved`.**
  The state is a claim about knowledge, not about intent: it says the reviewer never passed, so
  nothing is known. Phase 2 must label and colour the two differently, and must not word
  `unconfirmed` as *rephrased* - a reviewer that stops raising a change because it is fixed while
  raising something unrelated lands here too, and calling that a rewording is false.
- `roundsOpen` is a **count of appearances**, not a span, so it never claims a round the
  reviewer was silent in.
- The model covers **requested changes only**. Checks never flow through it. Phase 2 keeps the
  existing `checkOutcomeOf` path and routes on the outcome's `status`: a **failing** check
  renders in `Blocking` above the persona changes, and `passed`, `skipped` and `unavailable`
  render in `Passed`, the latter two keeping their degraded amber chip.
- Both phases descend from the round-folding rule in `src/server/workflows/repeat-offender.ts`.
  Changing one is changing both.

## Final verification

After Phase 2 merges:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run test:e2e
```

The acceptance check a person performs: open a run with requested changes, confirm the
blockers are readable without scrolling past a single passing reviewer, confirm a carried
change names the round that raised it, and confirm the pipeline above it is untouched.

## Audit

Every requirement in `plan.md` is owned by exactly one phase:

| Requirement | Phase |
| --- | --- |
| Blockers readable without scrolling past passes | 2 |
| A carried change names its first round and rounds open | 1 derives, 2 renders |
| A resolved change names the round that resolved it | 1 derives, 2 renders |
| Consecutive-failure reviewers are named | 2 |
| Per-change actions without leaving the worklist | 2 |
| A failing check keeps its exit code and output tail | 2 |
| Pipeline, header, scrubber, rail unchanged | Non-goal in both |

No phase depends on an unmerged later phase to repair an intermediate state.

## Review record

Inspector round 1 raised two `major` findings against the design, both verified against the
source and both accepted:

1. **Phase 1's `state` could flip a still-blocking change to resolved mid-round.** Stage 3
   personas do not finish together, so comparing each change's last-seen round against a global
   newest round archives every change owned by a reviewer that has not re-run yet. Resolution is
   now per owning `nodeId`, mirroring how `repeat-offender.ts` builds its candidate set.
2. **Phase 2 left a failing check with no segment.** Every check renders today regardless of
   outcome; as drafted, a failed command gate would have lost its exit code and output tail.
   Failing checks now sort into `Blocking`.

Round 2 raised one more `major`, also verified and accepted:

3. **The worklist was run-wide while the segment beside it was round-scoped.** `reviewAttempts`
   filters to the scrubber's viewed submission, so scrubbing to round 3 would have left
   `Blocking` and `Archive` on round 10 while `Passed` followed the scrubber. `runChangeWorklist`
   now takes an `asOfRound` window, which changed Phase 1's signature and Phase 2's call site
   together. The Inspector-only empty state was scoped to `Passed` in the same pass, since it was
   written for a round-scoped section and is false of a `Blocking` segment that carries changes
   forward.

Round 3 raised one more `major`, also verified and accepted:

4. **The change key carried no author.** Identity was `path` plus normalized title, mirroring
   `marker.ts` - but that module has exactly one Inspector and cannot suffer a cross-author
   collision, while a run has several personas reviewing at once. Two reviewers objecting about
   one file in identically-normalizing words would have folded into a single row keeping one
   `nodeId`, dropping the other's evidence and making its objection un-actionable, since Phase 2
   wires the disable and directive actions off the row's node. The key now leads with `nodeId`.

Round 4 raised one `minor`, accepted:

5. **A reworded finding could make the rail contradict itself.** An LLM reviewer that rephrases
   a title it keeps raising retires the old key, which read as `resolved` - on the same rail as a
   stalemate card, derived title-independently from `repeat-offender.ts`, calling that reviewer a
   repeat offender. `state` gains a third value, `unconfirmed`, derived from the rounds the
   worklist already walks rather than by reading `repeatOffenders`, whose latest-submission
   anchor and `rounds >= 2` threshold are wrong for a per-key, per-window question.

Round 5 raised one `major`, accepted:

6. **The stalemate card was not windowed like everything above it.** `detail.repeatOffenders` is
   computed over the run's whole submission list and anchored on its newest one, so scrubbing to
   round 4 of a 10-round run would have left the card reading "failed 10 rounds running" beneath
   segments correctly describing round 4. Phase 1's own round-4 audit record already named that
   anchor as unusable for a windowed question; the observation had been applied to `unconfirmed`
   and not to the card. Phase 1 now exports `runStalemates(detail, asOfRound)`, pinned against
   the payload field at the default window.

Round 6 raised one `major` and one `minor`, both accepted:

7. **The third state asserted more than the data supports.** It was called `superseded` and said
   the finding had been rephrased, decided purely from whether the owning node failed again for
   any reason. A reviewer that stops raising A *because A is fixed* while raising unrelated C
   landed in it, so the row told an operator their fix had merely been reworded. Renamed
   `unconfirmed` and narrowed to what is knowable: the reviewer never passed, so nothing is
   known. An evidence-or-path heuristic to separate the two was rejected as trading a known
   unknown for a confident wrong answer.
8. **The detail pane was specified only for changes.** `Blocking` holds failing checks too, and
   the selection was a bare key over two unreconciled id spaces. Phase 2 now defines a
   `WorklistItem` discriminated union with namespaced keys and branches on `kind`.

All eight fixes tighten the design without touching an approved human decision, so none was
escalated. Each phase's cross-phase audit record carries the detail.

Three of the five are the same class of mistake: a rule borrowed from a neighbouring subsystem
without checking which of its preconditions this one actually has. `marker.ts` has one author;
`repeat-offender.ts` compares within a round rather than across a global newest; the rest of the
reader pane is round-scoped. Each was right there in the source and each needed reading rather
than assuming.

The fifth and sixth are one lesson, and it is the more useful one: this document justified
duplicating the round-folding rule on the grounds that two derivations of one fact must not
disagree on one screen - then let that disagreement through twice more, once as an accepted
trade-off and once in the very card the principle was written to protect. The sixth is the
starkest, because the reason was already written down in an audit record and simply not carried
to the element beside it. **A principle stated once has to be applied everywhere it reaches,
and writing down why something is wrong is not the same as fixing everywhere it is wrong.**

Worth noting what the third one implies for the kept scrubber: "unchanged" means it keeps the
meaning it has today and now governs this section too, not that some of the page ignores it.
