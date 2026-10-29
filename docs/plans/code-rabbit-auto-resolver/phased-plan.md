# CodeRabbit follow-up: implementation phases

Source: [CodeRabbit follow-up in Shipping](plan.md).
Detailed implementation guide: [Phase 1: CodeRabbit observation and session follow-through](phase-1-coderabbit-follow-through.md).

## Approved inputs and scope

Human review 487d260a-88dc-4e6c-ad4b-601cafe30d0b selected “Create phased implementation plan” and “Approve final bundle” for root revision 2. Review 262f90a3-9572-4375-ba3a-394eeb0f589d selected an independent Shipping setting. Revision 3 first recorded those decisions; this complete phase bundle supersedes revisions 1 through 3 for implementation handoff.

The fixed outcome is the root plan's CR-1 through CR-8: prompt eligible owning sessions about unresolved CodeRabbit-origin review threads on adopted open PRs, behind an off-by-default Shipping setting that works with Inspector reviews off. Foreman consent, invitation, repository trust, workflow ownership, same-PR repair, conservative delivery and existing merge gates remain intact.

Only teamupstart/mission-control is an implementation repository. The issued checkout is repo-01. References to attached repositories describe the feature's runtime behavior, not additional repositories to modify in this planning or implementation task.

## Sizing and phase count

Estimate: 800 to 1,300 gross production lines added or materially changed, excluding tests and documentation.

| Area | Estimated production lines | Basis |
| --- | --- | --- |
| GraphQL normalization, pagination and observation-only polling | 180 to 300 | Existing provider and poller exist; completeness and bot identity need additive handling |
| Durable observation generations, claims and migrations | 220 to 350 | New state is required for restart-safe deduplication; use the existing adoption ledger and daemon database |
| Shared projections, daemon delivery boundary and Foreman integration | 250 to 400 | Existing consent, injection and follow-through code supplies the mechanisms |
| Shipping control, status and settings wiring | 150 to 250 | Extend the existing panel and ConsoleTable rather than adding a page |

This is a planning estimate, not a diff-size promise. It assumes the existing provider adapter, session ownership, injection path and settings registry remain reusable. Those seams were inspected in this checkout; implementation must adapt if main changes them.

Create exactly one implementation phase and one one-shot ship task. The feature crosses several layers but exposes one user action. A separate observation preparation phase would introduce a durable contract without the requested usable behavior; a separate UI phase would risk a setting that cannot yet deliver. The pure classifier, store, policy and fake-provider tests provide reviewable sub-boundaries within one pull request. No additional phase has a strong enough independent merge boundary to justify the handoff cost.

## Phase table

| Phase | Outcome | Direct prerequisites | Repository | Guide |
| --- | --- | --- | --- | --- |
| 1 | Complete opt-in CodeRabbit observation, safe follow-through and Shipping visibility | Planning session's plan-publication merge | mission-control only | [Phase 1](phase-1-coderabbit-follow-through.md) |

## Dependency graph and merge order

Planning session publication merge -> Phase 1 implementation task -> Phase 1 implementation PR merge.

There are no implementation-phase-to-phase edges. The only execution group is Phase 1. No implementation phases can execute concurrently because there is one phase. This plan does not serialize unrelated repository tasks.

Create Phase 1 after the approved Markdown bundle is committed and pushed and every task pointer resolves in that pushed commit. Its task must set `dependsOnCurrentSession: true` and omit `dependsOnTaskIds` or use an empty list. The planning-session edge releases only on publication by merge, not on this repair handoff, workflow approval or an open PR.

The actual returned task id and canonical repository set belong in the planning handoff and registered scheduling receipt. Do not fabricate an id in this index or create a second task after an uncertain response.

## Investigated findings and reconciliation

- The current Inspector tick checks `cfg.enabled` before reading any PR. The phase must separate remote observation from Inspector review authority so the approved independent switch works. Merely adding CodeRabbit to Foreman's predicate would not satisfy the goal.
- Adoption already runs while Inspector is off. Reuse it; no new PR discovery source is needed.
- The existing first GraphQL page and later thread pages have different comment shapes. Both need the same root-author identity and change metadata for CodeRabbit. Existing Inspector review-body and reply behavior must retain the data it consumes.
- Foreman's `FollowupMark` is in memory. Reusing it alone would repeat prompts after restart. Keep it for existing Inspector/CI semantics and put CodeRabbit's authoritative claim state in the daemon.
- Existing `/api/sessions/:id/inject` has daemon-origin attribution, `foremanWriteRefusal`, runtime dispatch and positive non-delivery semantics. Reuse that delivery machinery; a worker-side eligibility boolean or plain unbound prompt is not sufficient authority for a CodeRabbit claim.
- `TaskRepoPrSummary.feedback` is a live per-repository projection. A durable PR association survives closure and cannot by itself authorize a prompt.
- Shipping's config already uses schema defaults, config backups and a single patch route. There must not be a competing CodeRabbit toggle in Foreman config.
- Active workflows retain the session. This repair does not expand into workflow repair delivery. CodeRabbit state can be observed while its prompt is held.
- The review packet identifies absent phase artifacts, not a defect in the approved feature scope. This repair records the decision, supplies the complete phase and task dependency, and preserves CR-1 through CR-8.

## Cross-phase contracts

There is one implementation owner, Phase 1, for all new contracts. The following are semantic handoff constraints, not frozen private API names:

- Canonical PR identity comes from the adoption ledger, paired with the current repository and session/intent association.
- A complete observation, a retained historical observation and an eligible delivery are different facts. Errors or stale data never mean zero findings.
- Finding generation changes only for a new unresolved root finding, a root-finding edit or an observed resolved-to-unresolved transition. Head-only changes and shrinking sets do not re-arm delivery.
- Daemon state owns a claim before transport; only exact positive non-delivery can release it. Unknown sends are not retried.
- Registry/SSE and existing settings readers project the same observation and claim state. Inspector findings and review receipts remain separate.
- Shipping config authorizes this source; Foreman gates authorize messaging; existing Shipping merge gates authorize merge. None implies the others.
- The database upgrade and cleanup paths must preserve claims through restart and avoid replay while the same PR/conversation/episode remains eligible.

No later phase may be relied on to repair an unsafe or incomplete intermediate state.

## Requirement ownership and audit

| Source requirement | Sole implementation owner | Required proof |
| --- | --- | --- |
| CR-1: persistent independent setting | Phase 1 | Schema/restore checks and Shipping Playwright toggle/reload |
| CR-2: adopted PR observation through one poller | Phase 1 | Fake-provider worker test with Inspector off and CodeRabbit on |
| CR-3: complete CodeRabbit-origin thread detection | Phase 1 | Classifier/pagination tests including malformed, partial and page-2 data |
| CR-4: ownership and delivery policy | Phase 1 | Policy and daemon race tests; attached-repository and SDK/terminal paths |
| CR-5: durable duplicate suppression | Phase 1 | Real temporary-database claims, restart and uncertainty tests |
| CR-6: bounded useful session instruction | Phase 1 | Payload tests and fake-agent captured message |
| CR-7: truthful Shipping visibility | Phase 1 | Browser assertions for count, zero, unknown and held delivery |
| CR-8: compatibility, tests and documentation | Phase 1 | Merge-gate regressions, focused checks, build/smoke, E2E and docs review |
| Human choice: independent observation | Phase 1 | Inspector-disabled observation without model or GitHub writes |
| Human choice: phased follow-up | This planning repair | Complete bundle, pushed-path check, one created task and planning-session dependency |

Final cross-phase audit: all eight root requirements have one implementation owner; there are no consumers preceding a prerequisite, no invented concurrency, no second repository and no undocumented cleanup phase. The root, index and Phase 1 agree on default-off behavior, active-workflow holds, per-PR identity, conservative unknown delivery and unchanged merge authority.

## Verification and publication

The detailed phase owns implementation steps and exact focused commands. Planning verification checks every Markdown/HTML pair, source digest, relative bundle link, requirement row, dependency edge and publication path. Render and inspect the exact retained preview. The evidence bundle must contain the full current root, index and Phase 1 texts plus the unchanged contract context needed by tool-less Personas.

Repository policy is Markdown in Git, HTML retained locally. Only returned `requiredPaths` are committed. Evidence and screenshots stay gitignored. After exact-revision human approval, commit and push, verify all three Markdown pointers in the pushed commit, create exactly one dependency-gated task, and register its returned id and scope.

The Plan Validation v3 workflow owns PR publication. This planning repair does not create/update a PR, wait for PR CI, address PR comments or merge. The later workflow instruction owns that follow-through.
