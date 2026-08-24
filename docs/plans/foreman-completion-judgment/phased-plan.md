# Foreman completion judgment and recovery fixes - phased implementation

Source plan: `docs/plans/foreman-completion-judgment/plan.md` (rendered:
`plan.html`). Source finding: `docs/reports/foreman-completion-detection-stall/report.html`
(archived by Mission Control; summarized in the plan's Problem section, which stands alone).

## Incorporated human decisions (2026-08-24 plan review)

1. **Auto-submit on verification-evidence-only holds: included in Phase 1.** When a
   `foreman_complete` binding exists and a verdict is complete except for blocking gaps
   that all carry the evidence-class marker, claim the workflow instead of holding.
2. **Phase 2 authority: reuse `keepShipTasksMoving`.** No new config knob.
3. **Follow-up: phased implementation** - this document and its phase files.

## Investigated findings

Verified against the repository at commit `12e65358` during planning; the phase files carry
the details. The load-bearing facts:

- The daemon route `GET /api/sessions/:id/workflow-evidence` already exists
  (`src/server/routes.ts:1973`) and serves `WorkflowStagedEvidenceList`
  (`src/shared/workflow.ts:291`) for any live session's note key - no binding required
  (`stagedEvidenceForSession`, `src/server/workflows/manager.ts:1355`). Phase 1 adds only a
  Foreman client method; the worker never touches SQLite (repository boundary).
- The verify prompt renders transcript tool inputs only, never outputs
  (`src/server/foreman/prompt.ts:604-628`; `ToolCall`/`TranscriptMessage`,
  `src/shared/types.ts:3126-3153`), with a 48-turn window
  (`src/shared/protocol.ts:311`) and a 60 kB cap (`queue-prompt.ts:24`).
- `GapSchema.kind` (`src/server/foreman/queue-verify.ts:113-122`) is
  `incomplete | untested | standards | regression`; the dashboard renders the kind as free
  text (`src/web/components/WorkQueue.tsx:805`), so an additive value is display-safe.
- The persisted `PromptedCompletionGap` carries only `id`, `path`, `detail`
  (`src/shared/types.ts:1390-1397`) - no kind, severity, or strikes. Phase 1 therefore
  makes the fallback decision at verdict time in the worker; Phase 3 extends the persisted
  shape additively for cross-generation strikes.
- `PromptedRecoveryState` (`src/shared/types.ts:1449`) has no episode key; attempt
  continuity keys on the generation (`recoveryStateMatches`,
  `src/server/foreman/ship-shepherd.ts:71-87`), which is why the escalation budget resets
  every cycle. `PROMPTED_RECOVERY_REASONS` is append-only persisted vocabulary - phases
  extend JSON shapes additively and never rename or reorder existing values.
- The shepherd's delivery plumbing (claim, pre-inject re-check, inject, resolve, episode
  audit) lives in `runShipShepherd` (`src/server/foreman/worker.ts:1068-1319`) and is what
  Phase 2 extracts for shared use.

No discrepancies were found between the source plan's design and the repository; the plan
was written from the same investigation.

## Sizing and phase count

Estimated non-test implementation lines (gross added or materially changed):

| Phase | Estimate | Main surfaces |
|---|---|---|
| 1 | ~230-290 | `client.ts`, `queue-prompt.ts`, `queue-verify.ts`, `worker.ts`, `db.ts` + staging write (episode stamp) |
| 2 | ~120-160 | `worker.ts`, `ship-shepherd.ts` |
| 3 | ~130-170 | `src/shared/types.ts`, `ship-shepherd.ts`, `worker.ts`, daemon claim route |

Total ~480-620 lines, well above the one-phase threshold. Three phases rather than one
because each boundary isolates a distinct risk class in the repository's most
safety-critical worker, and each leaves the repository operable and independently
testable:

- Phase 1 changes **what the verifier sees and claims** (judgment). Combining it with
  Phase 2 would put prompt-injection surface changes and live-session typing changes in
  one review.
- Phase 2 changes **when text is typed into live sessions** (delivery safety). It
  deliberately relocates an existing, already-reviewed payload rather than inventing one.
- Phase 3 changes **persisted-state keying** (compatibility risk: old JSON must keep
  parsing and legacy states must not mis-continue). Reviewing that beside Phase 2's
  delivery change would force one reviewer to hold two unrelated risk models.

## Phase table and dependency graph

| # | Phase | File | Direct prerequisites |
|---|---|---|---|
| 1 | Evidence-grounded verification and the auto-submit fallback | `phase-1-evidence-grounded-verification.md` | none |
| 2 | Immediate held-gap delivery for managed ship tasks | `phase-2-immediate-held-gap-delivery.md` | Phase 1 |
| 3 | Episode-scoped convergence and escalation | `phase-3-episode-scoped-convergence-escalation.md` | Phase 2 |

Serial: 1 -> 2 -> 3. No concurrency group. All three phases edit the prompted hold path in
`src/server/foreman/worker.ts`; Phase 1's fallback changes which holds still exist for
Phase 2 to deliver, and Phase 3 re-keys the attempt accounting Phase 2 relocates. Merge
order equals phase order.

## Cross-phase contracts

- **C1 (Phase 1 owns): the verifier's evidence input.** `VerifyInput.registeredEvidence`
  and the registered-evidence statement: daemon-generated metadata (counts, kinds,
  generations, timestamps, sizes) above the untrusted fence; child-authored display
  names, source locators, and captions inside it. Evidence rows are stamped with the
  resolved intent episode key at staging and only same-episode items are admitted - to
  the items, the count, and the fallback. Zero admitted items is stated as "clause not
  satisfied"; a nonempty list is stated as a count only, with coverage judgment left to
  the verifier. Later phases must not move content across that fence, and Phase 3's
  decision `episodeKey` uses the same resolved key as the evidence stamp.
- **C2 (Phase 1 owns): the evidence-class gap kind.** One additive `GapSchema.kind` value,
  `"unverified"`, meaning "the change looks done; only proof of verification is missing".
  Phase 3 persists it; nothing renames existing kinds.
- **C3 (Phase 2 owns the entry point, Phase 3 the keying): single recovery accounting.**
  The daemon's `PromptedRecoveryState` remains the only attempt ledger; an attempt counts
  once per delivery whether the shepherd or the in-pass path delivered it. Phase 3 changes
  continuity to the intent episode without adding a second ledger.
- **C4 (all phases): safety invariants.** Consume-before-type ordering, the
  post-model-call candidate refresh, injection fencing of child-authored text, and the
  Foreman-worker-never-touches-SQLite boundary are preserved exactly.

## Final verification strategy

Each phase runs its focused tests plus `npm run typecheck` and `npm run lint`, and the full
`npm test` before its pull request (per the repository's definition of done). No phase
changes a UI surface, so no new `e2e/` spec is required - the affected behavior has no
browser-visible control; the Foreman drawer renders episodes and gap kinds as free text it
already handles. The end state is validated by the three worker-level tests named in the
source plan's success criteria, spread across the phases that introduce them.

## Cross-phase audit record

- 2026-08-24: initial decomposition. Phase 1 was given ownership of the gap-kind
  vocabulary (C2) even though only Phase 3 persists it, so the verifier's prompt and the
  fallback share one definition from the start and Phase 3 cannot drift it.
- 2026-08-24: Phase 2 was ordered after Phase 1 (not concurrent) because the fallback
  claim changes the set of held verdicts reaching the delivery branch, and both edit
  `processPromptedWrapup`.
- 2026-08-24 (post Phase-3 write): re-checked Phases 1-2 against Phase 3's additive
  persisted shapes; no earlier contract needed edits. Dependency directions and the
  no-concurrency claim re-confirmed.
- 2026-08-24 (Inspector round 1 on the plan PR): C1 tightened. Display names are
  child-authored at registration and moved inside the untrusted fence, and the
  registration clause is never declared satisfied from a nonempty item list - the trusted
  statement carries the count (zero stated as not satisfied) and coverage judgment stays
  with the verifier. Phase 1's steps, tests, and handoff updated to match; Phases 2-3
  unaffected.
- 2026-08-24 (Inspector round 2 on the plan PR): two boundary fixes. Phase 1 scopes
  evidence admission to the intent episode - the daemon stamps each staged row with the
  resolved episode key (additive `episode_key` column, Phase 1's estimate raised
  accordingly) and stale or legacy rows are excluded conservatively. Phase 3 makes the
  verification round durable - the decision persists a `heldRound` counter computed at
  the daemon's single write point, because the overwritten decision row cannot reconstruct
  consecutive-held history. Both keys derive from the same resolved intent episode, noted
  in C1.
- 2026-08-24 (Inspector round 3 on the plan PR): Phase 1's fallback gained a structural
  floor - at least one admitted same-episode evidence item, checked in the worker - so an
  `unverified`-only verdict cannot claim past a registration clause the prompt itself
  declared unsatisfied. Phases 2-3 unaffected.
