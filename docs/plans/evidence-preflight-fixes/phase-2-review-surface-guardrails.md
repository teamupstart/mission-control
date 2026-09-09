# Phase 2: Review-surface honesty and loop bounds

## Outcome and value

Personas stop failing submissions over a coverage requirement they cannot see (five of eight failing
verdicts on the observed run), the preflight-ready-then-Persona-reject disagreement becomes an
operator-visible signal instead of a silent counter, and a round can no longer loop through
unbounded consecutive preflight refinements. Together these make an evidence-plumbing failure
surface in one round instead of consuming a run's whole repair budget.

## Entry criteria and dependencies

- No phase dependencies; runs concurrently with Phase 1. Requires only the planning PR to be merged.
- Anchors verified at commit `4e0b70e7`. Line numbers cited below predate `main` at `c6e64be9`
  and have shifted by roughly +67 lines in `manager.ts`; every named symbol is intact. Read step 3
  before starting - the run lifecycle model landed in between and changed what a new blocked reason
  costs.

## Scope and non-goals

In scope:

- One added sentence in the Persona evidence-availability contract scoping coverage out of Persona
  judgment.
- A durable run event plus operator-visible surfacing when a Persona fails a submission whose
  readiness evaluation reported `ready`.
- A cap on consecutive `evidence_preflight` refinement segments within one round, blocking the run
  for the operator when exceeded.

Non-goals:

- Rendering canonical criteria, mappings, or coverage rows into the Persona prompt (recorded
  follow-up option in the source plan).
- Any change to intent, criteria, compaction, or fingerprints (Phase 1).
- Any change to evidence staging, reservation, or inheritance (Phase 3).
- No new Electron surfaces; no changes to `.github/workflows/`.

## Repository findings

- The Persona prompt's evidence-availability contract lives at
  `src/server/workflows/prompt.ts:78-81`; line 81 already scopes out later workflow stages
  ("Pull-request checks, remote CI, and Inspector findings may be later workflow stages..."). The
  file contains zero references to coverage, while the transcript and goal it renders carried the
  preflight's "declare and link an author-controlled coverage claim" instruction on the observed
  run.
- Readiness is evaluated and persisted per submission (`readiness_json` on `workflow_submissions`;
  evaluation and enforcement around `src/server/workflows/manager.ts:6150-6294`, event
  `evidence_readiness_evaluated` at `manager.ts:6266`). Persona verdicts land in
  `workflow_node_attempts.verdict_json`; the manager processes failing verdicts into repair packets.
- Run events append via `store.appendEvent` into `workflow_events` and reach the dashboard through
  the run views; run states and blocked reasons (`setRunState`, for example
  `unchanged_evidence_exhausted` at `manager.ts:6214`) are the existing operator-visible vocabulary.
- Preflight refinement segments are created with `refinementReason: "evidence_preflight"`
  (provenance in `src/server/workflows/store.ts:1028-1066`); nothing bounds consecutive segments,
  and `test/workflow-evidence-preflight.test.ts:280` drives fifteen in a loop.
- The consecutive-refusal pattern to imitate for the cap: `consecutiveUnchangedRefusals` and the
  nudge limit at `manager.ts:6206-6214`.

## Implementation steps

1. **Coverage disclaimer.** Add one sentence beside `prompt.ts:81` in the
   "# Evidence availability contract" section, stating that criterion coverage declarations are
   validated by the evidence preflight before Persona review, are not rendered here, and their
   presence or absence is not a Persona concern; a Persona must not fail a submission for missing
   coverage declarations. Keep the sentence in the same register as the existing contract lines.
2. **Disagreement signal.** Where the manager processes a failing Persona verdict for a submission
   whose persisted readiness status is `ready` under an enforcing policy, append a durable run event
   (for example `readiness_review_disagreement`) carrying the submission id, node id, and readiness
   generation. Surface it operator-visibly through the existing run event/state rendering in the
   dashboard run view; prefer the existing event-list surface over inventing a new widget. If any
   new user-visible UI element is added, a Playwright spec in `e2e/` is mandatory per repository
   policy, asserting the visible consequence by role or label, never `data-testid`.
3. **Refinement cap.** Count consecutive `evidence_preflight` segments within the current round
   (segment lineage via `parentSubmissionId` and `refinementReason`). At a small cap (2, matching
   the nudge-then-block pattern), stop creating further refinement segments, set the run to
   `blocked` with a dedicated reason (for example `preflight_refinement_exhausted`), and append the
   corresponding event. Follow the exceeds-the-limit comparison convention documented beside
   `consecutiveUnchangedRefusals` so the cap is not off by one.

   **This step gained a hard prerequisite after the plan was written.** `main` now carries
   `src/shared/workflow-lifecycle.ts` (PR #952), and a blocked reason is no longer a free string:
   the reason IS the run phase, `setRunState` takes the closed `WorkflowRunPhase` union derived
   from `WORKFLOW_RUN_PHASES`, and passing an undeclared phase is a compile error. Introducing
   `preflight_refinement_exhausted` therefore means registering it in three places beside the
   registry, all in that one file:

   - `WORKFLOW_RUN_PHASES`, which is what makes it spellable and executable at all.
   - `WORKFLOW_RUN_PHASE_STATUSES`, declaring the statuses it may be persisted under. For a
     terminal-ish operator block that is `blocked` alone; add `waiting_for_session` too if the cap
     is given a nudge-then-block shape like the unchanged-evidence guard.
   - `WORKFLOW_RUN_PHASE_DETAIL_KEYS`, an allowed-key whitelist for the detail payload. Include
     the segment count and submission id it records, and spread `DELIVERY_CARRIED_KEYS` if a
     delivery can land on the run while it is parked here.

   Do NOT reach for `setRunStateCarryingPhase` to sidestep the union. Its two legitimate callers
   are a free-form cancel reason and a delivery carrying an existing phase forward; it relaxes what
   may be SPELLED, never what may be persisted, and the same validation runs either way. The
   contract's own worked example is `inspector_inspector_disabled` - a phase minted by
   interpolation that no reader knew, which stranded every run that reached it. Read
   "One workflow run has one lifecycle state" in `docs/agent-guides/change-contracts.md` before
   writing the cap, and extend `test/workflow-run-lifecycle.test.ts` if the new phase needs a case:
   the contract test reads the registry maps rather than keeping its own copy.

   The disagreement signal in step 2 is unaffected. `store.appendEvent` writes an append-only
   event kind, which is not lifecycle state.
4. **Regression alignment.** Update `test/workflow-evidence-preflight.test.ts` so the fifteen-cycle
   loop either asserts the new block instead of endless refinement or exercises the cap boundary
   explicitly.

## Data and compatibility details

- New event kinds are additive strings in an existing append-only stream; no schema migration
  expected. A new BLOCKED REASON is not additive in the same sense - it is a run phase, and it must
  be registered in `src/shared/workflow-lifecycle.ts` as described in step 3. If a counter column
  proves necessary for the cap, follow the addColumn-in-migrate convention in `src/server/db.ts`.
- No changes to `src/shared/` wire contracts unless the dashboard needs a new `ServerEvent` variant;
  if one is added, `src/web/useEventStream.ts` must handle it exhaustively.

## Tests and verification

- `test/` unit coverage: the disclaimer text present in the built Persona prompt; the disagreement
  event appended exactly when readiness said `ready` and a Persona failed (and not under advisory
  policy or `gaps`); the cap blocking the third consecutive refinement and not the second.
- `e2e/` Playwright spec if and only if a new UI element is introduced; a spec opening a new modal
  calls `expectContentClearsBorder`.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`; `npm run build` plus
  `npm run test:e2e` when the UI surface changes.

## Merge and exit criteria

- All listed tests pass; typecheck and lint green; no unrelated edits.
- On a simulated ready-then-fail round, the operator-visible signal exists and the run still
  proceeds normally otherwise.
- One reviewable PR; no other phase waits on it.

## Downstream handoff

Later phases may rely on: the disagreement event name and payload shape once merged; the refinement
cap's blocked reason. Later phases must not change the Persona contract sentence's meaning (coverage
is preflight's to validate) without revisiting the source plan's coverage-visibility decision.

## Cross-phase audit record

- 2026-09-08 (Phase 1 implementation): Re-audited against `main` at `c6e64be9`. Step 3 gained a
  prerequisite from PR #952's run lifecycle model - a blocked reason is now a registered phase with
  declared statuses and detail keys, not a free string - and step 3 and the data section now say
  so. Steps 1, 2 and 4 are unchanged and remain independent of Phase 1. Phase 1 confirmed it
  touches neither the lifecycle triple, the Persona prompt, verdict handling, nor segmentation, and
  `readiness_json` is still written per submission exactly as this phase reads it. One note for
  step 4: Phase 1 rewrote two tests in `test/workflow-evidence-preflight.test.ts`, but not the
  fifteen-cycle loop this step targets.
- 2026-09-08: Initial version. Independent of Phase 1 (touches prompt wording, verdict handling,
  and refinement segmentation; reads readiness state that exists today) and of Phase 3 (no staging
  or reservation changes). Confirmed the disagreement signal reads `readiness_json` persisted per
  submission, which Phases 1 and 3 do not alter.
