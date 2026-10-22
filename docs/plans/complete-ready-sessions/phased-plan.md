# Complete all ready sessions - implementation index

## Source and adopted decisions

Source: [plan.md](plan.md), managed plan `25693837-91ba-4259-aa12-8a2e80c66112`. Revision 2 incorporated the human's revision 1 review; the final saved bundle identity and approval are supplied by Mission Control. No historical plan substitutes for this source.

The operator chose ready-only sessions, verified delivery, the whole Fleet including filtered-out sessions, one review-and-confirm dialog, and creation of implementation tasks. The root plan's FR-1 through FR-7 are the fixed outcomes. The phase document is the proposed implementation route and may adapt to source changes with a recorded explanation.

## Investigated findings and reconciliations

- Manual Complete eligibility is broader than the requested readiness. Introduce a daemon-owned reader over existing completion evidence; do not reuse the manual button's task-exists condition as proof.
- A finished turn and a completed Workflow are insufficient delivery evidence. Current-episode merge quorum, complete published Scout reports, exact local-plan receipts, and valid done-task records are the root plan's four branches.
- `currentEpisodeLanded` alone can find any merged repository; `liveEpisodeOutcome` and `mergeQuorumFor` enforce the complete changed-repository quorum. Reuse the full verdict, never the preliminary any-merge check.
- Scout `ensureReady` can capture. The preview needs a non-mutating read of its existing publication facts; execution still uses the real completion gate.
- TaskManager already has a durable closure ledger and a synchronous completion write after Scout I/O. Extend that seam for a guarded bulk caller and metadata-preserving closure of done tasks. Do not add a batch table or new eviction path.
- Existing manual completion may discard local changes. The approved ready-only bulk path skips unsafe or unknown resources instead of borrowing that manual override.
- The original agent guide contains historical filenames and cleanup details. Current architecture, TaskManager, Registry, and root plan control any conflict. No archived behavior is adopted over current source.
- No schema migration, new external service, new model execution, new top-level SSE collection, or CI/release configuration change is expected.

## Size and phase-count rationale

Estimated gross non-test production additions or material changes: **600-950 lines**. Planning estimate, not measured diff size.

Assumptions for this estimate: approximately 250-400 lines for eligibility readers, guards, and lifecycle integration; 100-170 for shared wire shapes and route/API adapters; 250-380 for the shared Fleet control, confirmation/results, state refresh, and styles. Tests and documentation are excluded from this estimate. The implementation may reuse more existing code.

Create **one coherent vertical phase**. The readiness rule, race-safe execution, count, confirmation, and honest results are one operation. Splitting by application layer would ship an unused API or a control whose policy is incomplete. Existing closure, publication, archive, merge, and resource owners make the combined slice feasible without a separate migration or infrastructure milestone. All tests and documentation travel with the behavior.

## Phase and ownership map

| Phase | File | Fixed outcome ownership | Direct merge prerequisites | Repository |
| --- | --- | --- | --- | --- |
| 1 - Complete ready sessions | [phase-1-complete-ready-sessions.md](phase-1-complete-ready-sessions.md) | FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7; every recorded product choice | This planning session's artifact publication merge | mission-control only |

Exactly one implementation task will be created after all three Markdown paths are committed, pushed, and verified in the remote branch. The actual returned task ID and planning dependency are registered as handoff evidence; no placeholder task ID is a scheduling result.

## Dependency graph and concurrency

Planning artifact commit and push -> schedule Phase 1 in backlog -> planning publication merge -> Phase 1 may dispatch -> Phase 1 implementation PR merge -> feature delivered.

Phase 1 directly depends on the current planning session through `dependsOnCurrentSession: true`. It has no implementation-task prerequisites. There is one implementation concurrency group containing Phase 1, and no parallel phase execution or cross-repository merge order. Workflow success or this turn's completion does not release the planning merge edge.

## Contracts within the phase

One authoritative readiness verdict serves the count, confirmation preview, and guarded execution. Read-only preview never captures, completes, or stops. The confirmed set is frozen by identities; it can shrink through revalidation and can never expand during execution.

TaskManager owns task completion, outcome preservation, archive gating, closure obligations, and worktree return. Registry owns eviction and durable removal. Existing merge/publication rules own dependency release. Active workflows, ensembles, and pipelines retain their completion authority. The Fleet operation is an explicit closure request and does not change automatic close-after-merge preferences.

The button reads the full Fleet, regardless of filters. Browser refreshes may react to existing SSE invalidations and reconnect, with bounded/coalesced requests; no interval polling or client-side readiness fold. Each accepted closure is recoverable independently of the batch HTTP connection.

## Verification and publication

Phase 1 owns the root verification strategy: focused node:test policy and daemon integration, fake-agent Playwright, pixel inspection across layouts/themes/narrow width, typecheck, lint, build, smoke, and E2E. See the phase file for commands and scenarios.

For this planning task, validate exact saved Markdown/HTML parity, static offline renderings, required artifact paths, the one-phase ownership graph, recorded decisions, and the complete evidence inventory. Implementation tests have not run and are not evidence for this plan.

Pinned storage policy: repository Markdown, HTML retained locally and excluded from Git. Required repository files are `plan.md`, `phased-plan.md`, and `phase-1-complete-ready-sessions.md` under `docs/plans/complete-ready-sessions/`. Save all six Markdown/HTML bundle members. Obtain approval of the complete final revision before commit/push and scheduling.

The current selected workflow owns publication. Refresh publication context after scheduling. Hand off the approved artifacts, task map, and registered full-text evidence. Do not create a PR, respond to PR reviews, wait for PR CI, or merge in this planning turn.

## Complete-set compatibility audit

- FR-1 through FR-7 and every submitted choice are each owned by Phase 1 exactly once.
- No phase consumes unmerged implementation output, introduces a dead UI, or expects a later cleanup phase.
- Routes are explicitly proposed, not falsely described as existing.
- No assumption of model-derived readiness or a general existing ready flag remains.
- Full merge quorum, current episode, complete archive, exact plan publication, pending work, and resource safety agree with the root plan.
- Existing done metadata and dependency edges remain untouched by repeated closure requests.
- Final HTML and Markdown share the same six-file bundle; only the three returned Markdown paths enter Git.
- The source, index, and single phase were compared together before final save. No cross-phase reconciliation remains open.
