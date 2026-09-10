# The goal a workflow run is judged against

## Problem

A workflow run reviews a submission against `primaryGoal.rawPrompt`, and that value is the
session's LATEST accepted prompt rather than its durable objective. Personas read it as
`# Original human intent`, may cite it as evidence of kind `goal` to fail a change, and the
run's constraints, canonical acceptance criteria and evidence-readiness gate are compacted
from it and nothing else. A prompt that only steered the work - `continue`, `you still
working?`, `create pr` - therefore becomes the contract the diff is measured against, and the
repair packet prints it back to the agent under the heading `Original user goal:`.

The investigation behind this plan is the Mission Control scout archive for task `5831fbba`,
"Fix goal overwriting in workflow rounds". Its report is archived rather than committed, so the
findings it established are restated here and in `phased-plan.md`. Measured read-only against the operator's live state on 2026-09-10, 21 of 25 runs carrying a
frozen intent were judged against something other than the session's durable objective, and 10
of those 25 were text Mission Control typed itself.

## Approved goal

A workflow run is judged against what the human is actually trying to achieve, the operator
can see which ask a run froze and whether it looks wrong, and steering a session no longer
silently rewrites the acceptance contract.

Three changes deliver that. They were selected by the operator from the report's five
proposals.

### A. The durable objective is the review contract

Capture builds the run's frozen intent from `SessionGoal.objective` - the completion contract
the goal refiner already protects from steering - instead of `SessionGoal.prompt`, and freezes
the human's opening ask beside it as provenance, stored exactly as the Goal pipeline already
stores every prompt - clamped by `clampPrompt` at 4,000 characters with an elided middle, so a
very long request is preserved in that clamped form rather than byte for byte. Mission Control already decides, per
instruction, whether new input changes the objective (`amend`, `replace`) or only steers it
(`steer`, `unclear`); the workflow has simply never consulted that decision.

The Persona prompt renders the objective as the contract and the opening ask as what it came
from, so a reviewer still sees the request in the human's own words as the Goal pipeline
recorded it.

### C. Steering reaches Personas as steering

Once A lands, a reconciled steering instruction is no longer visible to a Persona except as
raw transcript, and real steering is often exactly what a fair review needs: "skip the E2E for
now, the harness is broken" must not read as missing evidence. Personas receive a bounded,
clearly subordinate section carrying the steering the session accepted, stated as method and
sequencing changes that do not move the acceptance contract above them.

### E. A suspicious goal is visible before it decides anything

The freeze classifies the ask it is about to write - it matches a known automated payload
shape, it is implausibly short, or the session's newest instruction is still unreconciled -
records that verdict on the run, and surfaces it in run detail. The defect this plan fixes was
a query anybody could have run for months and the product said nothing.

## Decisions already taken

- **Proposal B, refusing to capture a goal from text Mission Control typed, is out of scope.**
  It is implemented on task `fb317738`'s branch as commit `a8610a7b`, "fix(goal): stop injected
  prompts overwriting the session Goal". This plan assumes it merges and does not restate it.
  Four senders in that commit still record authorship after the write rather than reserving
  before it (`workflows/manager.ts:6031` and `:3278`, `retro.ts:204`, `skills/reload.ts:292`);
  that residue belongs to B's own follow-up, not here.
- **Proposal D, an operator-owned goal correction on the run, is deferred.** Three of the 25
  measured runs are the operator typing the goal back into the pane to win the race against
  capture, so the demand is real, but it is a product surface with its own review and it is not
  required for A, C or E.
- **The intent fingerprint keeps its current derivation.** `workflowRunIntentFingerprint` is
  recomputed on every read and a run whose stored fingerprint disagrees is marked unreadable
  and blocked. Anything this plan adds to the snapshot is additive and excluded from the
  fingerprint, so no existing run becomes unreadable.
- **A run frozen before this plan keeps the ask it was frozen with.** Nothing rewrites a
  durable snapshot. The improvement applies to runs created after the change, exactly as the
  intent snapshot itself did.

## Constraints

- `src/shared/` stays browser-safe and carries wire contracts only.
- Schema changes live beside their upgrade path in `src/server/db.ts`.
- The session Goal itself stays live and keeps being displayed as the conversation's current
  objective. This plan changes what a REVIEW reads, not what the card shows.
- Every UI surface this plan changes carries a Playwright spec in `e2e/`.
- Mid-run human input is still not an amendment. An ask that genuinely changed is a new run.

## Out of scope

- Changing how the session Goal is captured, refined, or reconciled. The goal refiner's
  classification is consumed here, not modified.
- Any change to transcript capture, evidence staging, coverage, or the Inspector.
- Re-compacting or repairing criteria for runs that already exist.
