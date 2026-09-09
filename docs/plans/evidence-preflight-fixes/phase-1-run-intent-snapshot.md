# Phase 1: Run intent snapshot and run-frozen criteria

## Outcome and value

A workflow run judges every submission against the intent that existed when the run started. The
session Goal, which Mission Control's own repair packets can overwrite through the prompt hook, is
no longer the review's source of truth. Canonical acceptance criteria are compacted once per run and
stay stable across every round and refinement, ending the criteria drift (4, 3, 6, 5, 5, 5, 5, 7, 2
on the observed run) and cutting roughly 21 context-model calls per run to 2. Repair packets can no
longer appear under "# Original human intent" in any Persona prompt.

## Entry criteria and dependencies

- No phase dependencies. Requires only the planning PR (this plan's artifacts) to be merged.
- The repository at current `main`; all cited anchors verified at commit `4e0b70e7`.

## Scope and non-goals

In scope:

- Persisting an intent snapshot on `workflow_runs` and freezing it at run creation.
- Reading frozen intent (raw goal, refined goal, human decisions) during context capture instead of
  the live Goal and live decision extraction.
- Compacting canonical criteria once per run, storing them on the run, and reusing them for every
  submission.

Non-goals:

- No change to how the session Goal itself is captured or displayed (`captureHookGoalPrompt` and
  `captureAcceptedPrompt` stay as they are; the dashboard Goal remains live).
- No change to transcript capture, attribution, or filtering; the transcript stays a live
  per-submission read.
- No evidence or coverage storage changes (Phase 3).
- No Persona prompt wording changes (Phase 2).
- No operator intent-amendment event; if the operator's ask genuinely changes mid-run, that is a new
  run.

## Repository findings

- Runs are created inside `createInitialSubmission` (`src/server/workflows/store.ts:5316`), which
  inserts `workflow_runs` in a transaction with the round-1 submission. This is the freeze point:
  the earliest moment a durable run row exists. There is a second `INSERT INTO workflow_runs` around
  `store.ts:5480`; both insert paths must freeze the same snapshot shape.
- The live intent enters capture in `readWorkflowContextRaw` (`src/server/workflows/context.ts:918`):
  `registry.getGoal(session.id)` at `context.ts:923`, `primaryGoal.rawPrompt` from `goal?.prompt` at
  `context.ts:971`, and `boundedDecisions` at `context.ts:952` combining resolved reviews, Foreman
  episodes, and `humanTranscriptDecisions` of the filtered transcript.
- `intentFingerprintFields` (`context.ts:201`) returns `{rawGoal, refinedGoal, decisions}`; it is
  both the whole compaction prompt (`compactPrompt`, `context.ts:479`) and the intent fingerprint
  (`context.ts:220`).
- Criteria reuse (`reuseWorkflowContextCriteria`, `context.ts:597`) is gated in the manager at
  `manager.ts:6029` on `refinementReason === "evidence_preflight"` plus a fingerprint match, so it
  never applies across Persona repair rounds. It fired zero times on the observed run.
- Schema for `workflow_runs` is created in `src/server/db.ts:1355`; the repository convention keeps
  migrations next to the upgrade path (`addColumn` in `migrate()` plus the CREATE TABLE for fresh
  databases).
- The Persona prompt renders `context.primaryGoal.rawPrompt` and `context.humanDecisions`
  (`src/server/workflows/prompt.ts:61`, `prompt.ts:65`); no prompt change is needed here because
  fixing what capture puts into `primaryGoal` fixes what the prompt renders.

## Implementation steps

1. **Schema.** Add an intent-snapshot column to `workflow_runs` (for example `intent_json TEXT`)
   holding `{rawGoal, refinedGoal, decisions, fingerprint, frozenAt}`, and a column for run-level
   canonical criteria (for example `context_criteria_json TEXT`) holding
   `{constraints, acceptanceCriteria, canonicalCriteria, compaction}` once compaction succeeds.
   Follow the addColumn-in-migrate convention in `src/server/db.ts`; a pre-existing run without a
   snapshot keeps the current per-submission behavior (see step 6).
2. **Freeze at creation.** In both `workflow_runs` insert paths in `store.ts`, accept and persist
   the snapshot. The manager builds it right before creating the run, from the same sources capture
   uses today: the bounded goal (`registry.getGoal`), and the bounded decisions (resolved reviews,
   Foreman episodes, human transcript decisions at that moment). Reuse the existing bounding helpers
   in `context.ts` rather than duplicating clamp logic.
3. **Read frozen intent in capture.** Thread the run's snapshot into `readWorkflowContextRaw` (it
   already receives the binding; pass the run snapshot alongside or resolve it via the store) and
   populate `raw.primaryGoal` and `raw.humanDecisions` from it. Remove the live
   `registry.getGoal` read for intent purposes. The intent fingerprint becomes the frozen
   fingerprint.
4. **Compact once per run.** In the manager's capture path (`manager.ts:6026` region): if the run
   already has stored criteria, use them for every submission (still running
   `reconcileWorkflowCriterionMappings` against the submission's staged coverage). If not, compact
   from the frozen intent and store the result on the run atomically. Delete or bypass the
   preflight-only reuse gate at `manager.ts:6029`; `reuseWorkflowContextCriteria` may be reshaped
   into the run-level reuse helper rather than kept alongside it.
5. **Fallback semantics.** Keep `fallbackWorkflowContext` behavior: a failed compaction stores
   nothing on the run and the next submission retries, exactly as a failed compaction retries today.
6. **Compatibility.** A run created before the migration has no snapshot: capture falls back to the
   current live-read behavior for that run only, so in-flight runs keep working across a daemon
   upgrade. New runs always freeze.

## Data and compatibility details

- Both columns are nullable TEXT holding JSON validated by Zod schemas beside the existing
  `WorkflowContextSnapshotSchema` shapes in `src/shared/workflow.ts` or the store's row schemas,
  matching where sibling shapes live.
- No persisted append-only IDs are renamed or reordered. No changes to eviction, registry ownership,
  or session lifecycles.
- The snapshot deliberately excludes repository state, evidence, and Persona feedback, exactly as
  `intentFingerprintFields` documents today (`context.ts:218`).

## Tests and verification

- `test/` unit coverage (node:test, following existing workflow store/manager test patterns):
  - A run created while the Goal holds the human's request freezes that request; overwriting the
    Goal with a packet-shaped prompt afterward does not change any later submission's
    `primaryGoal.rawPrompt`, `humanDecisions`, or intent fingerprint.
  - Criteria are compacted exactly once across a multi-round run, including across
    `evidence_preflight` refinement segments and Persona repair rounds; the criteria set is
    identical on every submission.
  - A pre-migration run (no snapshot) still captures via the live path.
  - Compaction failure on submission 1 retries on submission 2 and then persists run criteria.
- Commands: `npm run typecheck`, `npm run lint`, `npm test`. Run the workflow-focused files directly
  with `node --test --import ./test/setup-state.mjs --import tsx <file>` during development.

## Merge and exit criteria

- All listed tests pass; typecheck and lint green; no unrelated edits in the worktree.
- The frozen-intent contract holds: no code path between run creation and Persona prompt rendering
  reads the live Goal for review intent on a snapshot-bearing run.
- One reviewable PR; its merge releases Phase 3.

## Downstream handoff

Later phases may rely on:

- Every new run carries a frozen intent snapshot and, after first successful compaction, run-level
  canonical criteria that never change for the run's lifetime.
- `raw.primaryGoal` and `raw.humanDecisions` on a snapshot-bearing run are packet-proof.
- Criteria stability means coverage reconciliation targets are stable across rounds (Phase 3 builds
  inherited-coverage mapping on this).

Later phases must not change: the snapshot's freeze timing, its exclusion of repository state and
evidence, or the once-per-run compaction contract.

## Deviations taken during implementation

The route above held. Four places where the repository disagreed or a better implementation
presented itself, recorded per the task's instruction:

1. **Column names.** `workflow_runs.intent_json` as proposed, but the criteria column is
   `run_criteria_json` rather than `context_criteria_json`. It holds RUN criteria, not a context
   snapshot, and the store already has `context_json` on submissions; the near-identical name
   would have read as the same thing at a different scope.
2. **The reuse gate has no fingerprint comparison.** Step 4 proposed reusing stored criteria per
   submission; the implementation reuses them unconditionally on a snapshot-bearing run. Frozen
   intent cannot move, so the comparison could only ever be true, and where an injected capture
   seam or a legacy row made it false, being false would silently restore per-submission
   compaction - the drift this phase removes, reintroduced through the guard meant to protect it.
   The fingerprint is recorded WITH the criteria as provenance instead, and stamped onto each
   submission from the frozen snapshot rather than re-derived from the captured context. That is
   also what makes "every submission of a run carries one intent identity" assertable.
3. **A per-submission coverage bridge was added.** The phase file says reconciliation keeps
   running per submission against stable criteria, which is what happens - but stable criteria fix
   the TARGET, not the vocabulary an author aims at it with. Author claim ids are per-submission,
   so `criterionBridge` reads this submission's claims through the previous submission's claims
   and mappings (the parent for a refinement segment, the preceding snapshot otherwise). Without
   it, a round that rephrases a claim for an unchanged criterion would read as an unmatched new
   claim and open a coverage gap on a submission that changed nothing but its wording. This is a
   strict widening of the parent-only bridge that already existed on the preflight reuse path.
4. **`reuseWorkflowContextCriteria` was reshaped rather than duplicated.** It now takes a
   structural `WorkflowCriteriaSource` that both a sibling submission's context snapshot and the
   run's criteria satisfy, plus explicit source mappings. One function serves the run-level reuse
   and the pre-migration parent reuse, so the two cannot drift apart.

Two notes on the plan's arithmetic and on tests:

- The source plan estimates "roughly 21 context-model calls per run to 2". The compaction half is
  exactly that: one per run. Reconciliation stays per-submission and deterministic on the reuse
  path (no model call), which is what the phase file specifies; the model reconciliation runs once,
  with the compaction. So the real figure is 2 model calls per run, but the deterministic
  reconciler still runs on every capture, which is what keeps coverage mapping correct per round.
- Two existing tests in `test/workflow-evidence-preflight.test.ts` encoded the contract this phase
  replaces and were rewritten rather than deleted. "one changed human decision recompacts once"
  asserted exactly the behaviour that made the failure possible; it is now "a mid-run change to the
  live decisions never moves the run's frozen criteria". "fallback compaction retries before
  becoming a stable criteria reuse source" drove its fallback by hand-editing a stored submission
  row, which no longer changes anything; it is now "a corrupted submission context cannot restart
  the run's compaction", and the genuine first-compaction-failure retry moved to
  `test/workflow-run-intent-snapshot.test.ts` where a Persona repair round can drive it.

## Interaction with the run lifecycle model (PR #952)

`main` gained `src/shared/workflow-lifecycle.ts` after this phase was written. It constrains the
`status` / `current_phase` / `gate_state_json` triple: `setRunState` takes the closed
`WorkflowRunPhase` union, and every declared phase declares its permitted statuses and detail keys.

This phase is orthogonal to it and deliberately stays so. `intent_json` and `run_criteria_json` are
independent columns, not lifecycle state and not phase detail, and nothing here writes a run status
or phase. Do not park intent or criteria in `gate_state_json`: the gate is sticky lifecycle state
compared by exact JSON, and the decoder would classify anything else there as `opaque`.

Phase 2 is affected and its file records this: a new blocked reason is no longer a free string.

## Repair round 1 (No-Mistakes Review v14)

Three findings, all upheld. What each turned out to be on inspection:

1. **Once-per-run was enforced after the model call, not before it** (Code Risk Reviewer, Code
   Quality Judge). Correct, and worse than the packet described. `freezeRunCriteria` is a
   compare-and-set on a finished value: it bounds what is STORED, not how many compactions are
   produced. The defence I had relied on beyond it was `withCaptureLock`, and that lock is
   genuinely broken - every waiter awaits the SAME `before` promise and then each overwrites the
   map with its own, so three or more concurrent callers on one note key all proceed together.
   The fix is a run-scoped claim (`runCriteriaClaims`) registered synchronously before any spend,
   which concurrent captures await; the compare-and-set stays as the durable backstop. A waiter
   whose winner fell back degrades identically instead of starting its own attempt, so
   retry-after-failure still belongs to the next submission.
2. **A second, self-inflicted bug the same analysis exposed.** The run-level reuse decision read
   `runRow.criteria` from a row resolved BEFORE the capture's git work. A capture that started
   while the column was null and finished after another had filled it would recompact. Now read
   fresh after capture, and pinned by a test that fails with 2 compactions against the old read.
3. **One nullable `intent` meant three things** (Code Design Reviewer). Upheld, though the
   packet's second evidence item quoted a comment of mine that was simply wrong: `parseNullableJson`
   throws rather than dropping, so a damaged snapshot did not fall back to live - it made `getRun`
   return null and the run vanish from every listing. Both behaviours are wrong. `intentState`
   now separates `frozen` / `never_frozen` / `unreadable`; `unreadable` blocks the run under
   `capture_error` with code `run_intent_unreadable` while keeping the row readable; and all three
   production creators refuse to create a run when the ask cannot be read, so a new run can no
   longer be born onto the legacy path. The insert field stays optional in the TYPE so a fixture
   can still build a genuinely snapshot-less run - which is the only way to test the
   pre-migration path the plan requires keeping.

**Reported, not fixed:** `withCaptureLock` (`manager.ts`) does not serialize three or more
waiters. It is pre-existing, shared by every capture path, and outside this packet; the repair
above is correct independently of it. It deserves its own change.

## Repair round 2 (evidence preflight)

A coverage-mapping repair, plus one gap it exposed. The preflight named three criteria and asked
for exactly one author claim each; the first two were already backed by tests and only needed
claims whose text maps unambiguously. The third was not:

- **"Pre-migration runs continue functioning via existing live-read path without modification"
  had no end-to-end proof.** Every other test here exercises a FROZEN run. The only legacy
  evidence was a control assertion on `readWorkflowContextRaw` inside another test, which proves
  the live intent read but not that a snapshot-less RUN still compacts per submission and freezes
  nothing. `a pre-migration run keeps reading intent live and compacting per submission` now
  drives one end to end: it nulls `intent_json` - which is what an upgrading installation's rows
  genuinely are, and the only honest way to obtain one now that the manager refuses to create a
  snapshot-less run - then asserts `never_frozen`, that round 2 reads a CHANGED live Goal,
  that it compacts again, and that no run-level criteria are ever frozen.

Coverage claims now use the canonical criterion text verbatim. That is deliberate rather than
stylistic: `reconcileWorkflowCriterionMappings` bridges on exact normalized criterion text, so a
paraphrase is what leaves a criterion matching zero or several claims. The round-1 registration
had one claim describing both the mechanism and the test that proves it, which is why two criteria
each reported an ambiguous match.

## Repair round 2, review (Code Design Reviewer)

One finding, upheld. `WorkflowRunCriteria` reused the context snapshot's compaction receipt,
whose `status` is `model | fallback`, and `WorkflowRunCriteriaSchema` accepted both. The
implementation's contract is that only a successful model compaction may become durable run
criteria - `workflowRunCriteriaFrom` returns null for anything else - but that left the forbidden
state representable, so any future caller of `freezeRunCriteria` could store and then permanently
reuse an empty criteria set. That is the same standstill as drifting criteria, reached from the
other direction.

`status` is now the literal `model` in both the type and the schema, so the store refuses the
payload at its own boundary. The narrowing immediately paid for itself: `workflowRunCriteriaFrom`
stopped compiling, because spreading the snapshot's receipt carries the wider declared type even
after the guard has proven the value - the literal is now restated so the proof reaches the type.
A store-level test pins the refusal.

## Repair round 3, review (Code Design Reviewer)

One finding, upheld, and it is the half of round 1's third finding I left open. I gated the three
production creators but kept `intent` optional on the store inputs, arguing that fixtures need to
build legacy rows. That put the invariant in the callers rather than at the boundary that owns it:
a future or alternate caller could omit the field and mint a new run entitled to the mutable live
Goal for its lifetime, indistinguishable afterwards from a genuine pre-migration row.

`intent` is now REQUIRED on `WorkflowRunInsert` and `ForemanCompletionStoreInput`, typed
`WorkflowRunIntentSnapshot | PRE_MIGRATION_RUN_INTENT`. The legacy shape stays buildable, because
the pre-migration path must stay testable, but only by naming the marker - so forgetting the field
is a compile error and a `never_frozen` row is one somebody asked for. Twenty-three fixtures across
the suite now state the legacy shape explicitly, which is worth the churn: each of those sites is
now self-documenting about which path it exercises.

The reviewer's alternative was durable provenance in a new column. The required-input route was
chosen because it removes the accident at the point it would be made rather than classifying it
afterwards, and because it needed no migration. If a non-TypeScript writer ever inserts rows
directly, provenance becomes worth revisiting.

## Repair round 4, review

Two findings, both upheld.

**Criteria provenance was unchecked** (Code Risk Reviewer). `readRunIntent` parsed `intent_json`
and `run_criteria_json` independently and returned both as usable. A criteria payload that parses
perfectly can still have been distilled from different intent, and reuse would then judge the run
against somebody else's ask. A fingerprint comparison between the two stored columns now runs at
the read boundary, and a mismatch is `unreadable` - which capture already blocks - rather than a
recompaction or a fall back to the live Goal. This does not contradict the deliberate absence of a
fingerprint comparison on the reuse branch: that one would compare the CAPTURED context against
the frozen value, where a disagreement can only come from an injected read and being false would
silently restore per-submission compaction. This one compares two durable halves of one row, where
a disagreement means the row is wrong.

**The pre-migration marker was still in the production contract** (Code Design Reviewer). Round 3
made `intent` required but typed it `WorkflowRunIntentSnapshot | PRE_MIGRATION_RUN_INTENT`, and
`frozenIntentJson` mapped the marker to the same SQL NULL a genuine legacy row has. So a
production caller could still deliberately create a snapshot-less run, and afterwards nothing
could distinguish it from historical data. The marker is gone: both inputs take a real snapshot
and nothing else. The legacy shape is reachable only by DEMOTING a row - nulling `intent_json`,
which is what an upgrade leaves behind - and the pre-migration test already did exactly that, so
it needed no change. The 23 fixtures that carried the marker now carry
`FIXTURE_RUN_INTENT` from `test/helpers/workflow-run-intent.ts`, which is the honest shape for
them: none of them exercise the legacy path, they simply need a run.

## Repair round 5, review (Code Design Reviewer)

One finding, upheld, and my own fixture was the proof: `FIXTURE_RUN_INTENT` carried
`fingerprint: "f".repeat(64)`, sixty-four hex characters with no relationship to its goal. The
snapshot type publicly carried both the ask and the identity derived from it, and
`frozenIntentJson` validated only the shape - so every caller had to preserve an invariant the
snapshot abstraction owns, and round 4's criteria-provenance check was comparing against an
unverified duplicate.

The fingerprint is no longer an input. Both creation contracts take `WorkflowRunIntentInput` -
the ask fields alone - and the store derives the identity through `freezeWorkflowRunIntent`.
`readRunIntent` also recomputes it on read and treats disagreement as `unreadable`, because
deriving on write says nothing about a row an older build wrote from a supplied fingerprint or
one a partial write left half-updated. The computation moved to
`src/server/workflows/intent-fingerprint.ts`, a small module with no heavy imports, so the store
can derive without pulling capture's registry and provider machinery behind it and the two
cannot drift apart.

The fixture now has nothing to get wrong, which is the real measure of the repair.

## Repair round 6, review

Two findings, both upheld, both closing a boundary the earlier rounds left one step short.

**A foreign criteria write was only caught on read** (Code Risk Reviewer). Round 4 added the
provenance comparison in `readRunIntent`, which detects criteria distilled from another ask - but
detecting it there is a poor second best, because `run_criteria_json` is write-once. A bad write
could never be repaired through the freeze path and the run stayed unreadable for good.
`freezeRunCriteria` now refuses before the UPDATE: only a run whose intent is readable and frozen
may receive criteria, and only criteria bearing that run's fingerprint. The read-side check stays
as the backstop for rows this build did not write.

**A criteria-bearing row with no ask was read as pre-migration** (Code Quality Judge). The
`intent_json IS NULL` branch returned `never_frozen` without looking at the criteria column, so a
partial restore or two mixed rows could enter the live-read path. A genuine legacy run has
NEITHER column, because nothing ever wrote criteria for it. That shape is now `unreadable`, and a
regression drives it end to end: the ask is nulled while its criteria stay, the run blocks under
`capture_error`, no second compaction runs, and no submission carries the live Goal that replaced
the ask.

The distinction between this and the pre-migration test matters and is worth keeping: that one
nulls `intent_json` ALONE, which is what an upgrade genuinely leaves and which correctly takes
the live path.

## Repair round 7, review (Code Design Reviewer)

One finding, upheld, and slightly worse than it was framed. Round 5 introduced
`freezeWorkflowRunIntent` and documented it as the one place a snapshot is minted, but
`readWorkflowIntentSnapshot` kept assembling one by hand beside the derivation - and the
constructor was imported into `context.ts` and then never used. A claim of a single minting
boundary that the file itself did not honour.

Capture now mints through the constructor. The raw run-snapshot derivation is no longer
re-exported from `context.ts` either: nothing imported it from there, and leaving it beside the
constructor would be an invitation to hand-assemble a snapshot again.
`workflowIntentFingerprint` stays reachable there because capture genuinely hashes a LIVE
context for a legacy run, which has no snapshot to thaw.

No test changed. The property was already pinned: `a run reviews the ask it froze` asserts the
captured context hashes to the frozen fingerprint, which is exactly the agreement between the
two paths that this collapses into one path.

## Repair round 8, review (Slop Filter)

One finding, upheld, and self-inflicted. Round 4's marker removal was scripted: the regex
stripped `PRE_MIGRATION_RUN_INTENT` from each store destructure, and in the files where it was
the ONLY binding that left `const { } = await import(".../store.ts");` behind. Dead code that
makes a reader hunt for a module-load side effect there is no such thing.

Removed from FOUR files rather than the three named. `test/workflow-reset.test.ts` carries the
identical leftover from the identical cause, and shipping it while removing its three siblings
would have been knowingly leaving the reported defect in place. All four load `WorkflowManager`
on the preceding line, which imports the store, so the empty import was a genuine no-op rather
than load ordering; the four files pass unchanged at 28 tests.

## Cross-phase audit record

- 2026-09-08: Initial version. Phase 2 confirmed independent (prompt wording and guardrails touch
  neither the snapshot nor the criteria store). Phase 3 declared dependent on this phase's stable
  criteria contract and shared capture-path code region in `manager.ts`.
- 2026-09-08 (implementation): Re-verified every anchor against `main` at `c6e64be9`.
  `src/server/workflows/context.ts` is unchanged; `store.ts` shifted +38 lines and `manager.ts`
  +67, so the cited numbers are stale but every named symbol and both insert paths are intact.
  Phase 2's scope changed - see the lifecycle section above and that phase's own file. Phase 3 is
  unaffected by #952 (it touches evidence tables, not the lifecycle triple), and its dependency on
  this phase is unchanged: the capture region it extends now reads
  `runRow.intent` / `runRow.criteria` and calls `criterionBridge`, and inherited coverage maps onto
  criteria that no longer move.
