# Phase 3: The event log in the operator's words

Source plan: [`plan.md`](plan.md) section 3.4.
Index: [`phased-plan.md`](phased-plan.md).

## 1. Outcome

The ensemble Timeline's Events block stops printing the engine's internal enum members as the most prominent text on the block, and starts saying what happened in the words a person watching the run would use.

Today it renders `run_completed`, `member_eliminated`, `finalization_blocked`, `winner_materialized`, `stage_succeeded`, `run_recovered` in bold at body size, beside eighteen identical grey `5d ago` stamps. The system's vocabulary is the loudest thing in the block, and the only column that varies carries no information.

## 2. Entry criteria and dependencies

- Direct phase dependencies: **none**. Runs concurrently with Phases 1 and 2.
- Entry: `main` green.

## 3. Scope and non-goals

In scope:

- Humanise the event labels in the Timeline's Events block.
- Group events by stage rather than presenting a flat list.
- Make the timestamp column carry information.

Non-goals, explicitly:

- **Only the Events block.** `EnsembleTimeline.tsx` also renders Stage plan, Stage attempts, Evaluations, Decisions, and the finalization receipt. Those keep their current presentation; several deliberately expose driver keys and command keys for debugging, and that is not this phase's argument to have.
- No change to the dossier or the Best-of-N result (Phases 1 and 2).
- No server, schema, or wire change. Event records are read as they already arrive.

## 4. Repository findings

Verify each of these before relying on them; they were established by reading, not by running:

- The Events block lives in `src/web/ensembles/EnsembleTimeline.tsx`.
- The ensemble event `type` union is defined in `src/shared/ensemble.ts`. **Enumerate it from the source and cover every member** - a label map that silently falls through leaves a raw enum on screen for exactly the rare events an operator most needs to read.
- Check whether a humanising helper already exists before writing one: `src/web/ensembles/format.ts` (which has a `titleCaseEnum`-style helper) and `src/shared/ensemble.ts` (which has stage words such as `ENSEMBLE_STAGE_WORDS`). Reuse or extend rather than adding a third vocabulary. `plan.md` section 2.5 notes the run state is already spelled three different ways across the page; do not make it four.
- If the map goes in `src/shared/`, it must stay browser-safe: no `node:` imports. That boundary is enforced by the repo's controlled-paths rule.

**Copy standard.** Labels name what happened to the operator's work, not what the engine did to its records:

| Enum | Reads as |
| --- | --- |
| `winner_materialized` | Winner restored to a checkout |
| `member_eliminated` | Candidate 3 eliminated |
| `run_recovered` | Run resumed after a restart |
| `finalization_blocked` | Finalization blocked |

Use sentence case, active voice, and the same noun the rest of the page uses for the same object. Where the event carries an ordinal or a member, put it in the label - `Candidate 3 eliminated` tells you more than `member_eliminated` repeated twice.

**Terminology hazard.** `plan.md` section 2.3 records that the page already names the same three objects three ways (`Submission A/B/C`, `Candidate 1/2/3`, `#1/#2/#3`). Label resolution is deferred, so **do not introduce `Submission X` into these labels**. Use the candidate vocabulary the Members section uses.

**Timestamps.** Eighteen consecutive `5d ago` stamps carry nothing. Either show relative time only where it changes meaningfully, or show the offset from run start within a stage group. Whatever is chosen, an absolute timestamp must stay reachable - the repo added conversation timestamps deliberately (`feat: show timestamps in conversations`), so removing time information outright is the wrong direction.

## 5. Implementation steps

1. **Enumerate the event union** from `src/shared/ensemble.ts` and write the label map with a case for every member. Prefer an exhaustive `switch` or a `Record<EventType, string>` so a future event added to the union fails typecheck here rather than rendering raw.
2. **Place the map** beside the existing ensemble vocabulary helpers rather than inline in the component. If an existing helper already does most of this, extend it.
3. **Group by stage.** Bucket events under the stage they belong to, using the same stage words the pipeline already shows (`Launch`, `Work`, `Review`, `Decide`, `Promote`) so the Timeline and the pipeline agree. Events with no stage go in a clearly named final group; do not silently drop them.
4. **Rework the timestamp column** per the findings above.
5. **Type it down.** The Events block currently renders labels in bold at body size. Bring it into the app's scale - the label is the content, the timestamp is secondary.

## 6. Data, API, migration

None. The event records are already delivered to the client and rendered; this phase changes only how they are labelled and grouped.

## 7. Tests and verification

- `test/ensemble-page-render.test.ts` covers the timeline (for example "the generic detail renders the header, members with reported-vs-observed, and the timeline" around line 277, and the barrier/payload cases around 414). Update the structural assertions, keep the behaviours.
- Add a case asserting **every member of the event union has a label** - iterate the union and assert none renders as its raw enum. This is the assertion that stops the map rotting as events are added.
- Add a class-vs-stylesheet coverage assertion if new classes are introduced.

Commands:

```sh
node --test --test-concurrency=2 --import tsx test/ensemble-page-render.test.ts
npm run typecheck && npm run lint && npm test
```

**Playwright spec required** (`e2e/`): the event log renders operator words, not raw enum members. A negative assertion (no `_` -joined enum text in the Events block) is cheap and catches the fall-through case directly.

## 8. Merge and exit criteria

- No raw enum member renders in the Events block, for any event in the union.
- Events are grouped by stage, using the same stage words as the pipeline.
- Timestamps carry information.
- A new event type added to the shared union causes a typecheck failure here rather than a raw label.
- Typecheck, lint, unit tests, and the e2e spec pass.

## 9. Downstream handoff

Nothing depends on this phase. If label resolution is later un-deferred, the event labels are a second place `Submission X` would need resolving - note it there rather than pre-building for it here.

## 10. Cross-phase audit record

- Reconciled against Phase 1: no shared selector. Phase 1 changes `.ensemble-reported` / `.ensemble-checks` / `.ensemble-scorecard-cols`; this phase touches the Timeline's Events block. Disjoint.
- Reconciled against Phase 2: disjoint files and disjoint stylesheet regions. Either merge order is safe.
- Shared-file note: Phases 1, 2 and 3 may all touch `src/web/styles.css`, which is a single ~19,400-line file. The regions are far apart and auto-merge cleanly, but whichever lands last should re-run the full unit suite rather than trusting a clean textual merge.
