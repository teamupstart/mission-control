# Phase 2. Typed settings and generic coverage

Ordinary preferences in existing typed setting domains become searchable, readable and writable through mission_settings. A contributor can add another ordinary preference to an onboarded owner without editing the MCP transport, handler or prompt.

## Entry and scope

Repository: Mission Control. Direct prerequisites: the planning session and merged Phase 1. Phase implementer prerequisites include the [approved design](plan.md), [implementation index](phased-plan.md) and inventory delivered by [Phase 1](phase-1-session-access.md). Own ordinary, typed patch fields whose dashboard and daemon share a standard mutation path. Include nested and generated settings when the same pattern applies. Phase 3 owns specialized intents and remaining controls. Leave every pending row assigned to a real owning phase.

## Implementation order

1. Reconcile the Phase 1 inventory with src/shared/app-config-entries.ts and each owner’s public patch schema. A stored schema can supply defaults or coerce legacy data that should be rejected on an explicit write. Derive ordinary descriptors only for eligible, validated leaves in a reviewed owner, with stable names and aliases where a storage or display name can change. Keep reusable labels, keywords and generated keys in shared pure metadata. Preserve the search palette’s ordering, availability filters and bindings.

2. Extend the Phase 1 owner interface to use the selected value’s schema plus the real domain getter and patch service. Reuse typed adapters across ordinary fields. For example, the harnesses PUT route catches HarnessesConfigError and emits emitHarnessesConfigChanged; share both paths. Prove a second domain handles a validation or notification consequence different from skin. Check each classified typed domain, including display, keyboard and dispatch, storage limits, models and background workers, against the inventory. Group by owner behavior, not tab label.

3. Patch just the selected field against current state at commit, preserving other fields, unknown downgrade-compatible values and owner normalization. Serialize read-modify-write or use owner-supported conditional updates when concurrent dashboard/MCP writes could interleave. For object or array replacement use Phase 1’s version precondition and reject a stale get. A narrower owner edit is acceptable where replacement is unnecessary. Reject inherited object paths and unrecognized nested fields. Return the effective persisted field only and never echo an oversized or secret-bearing input.

4. Wire owner notifications into existing event subscribers and use Phase 1’s bounded invalidation when necessary. Respect feature gates and owner cross-field invariants on read, discover and set. Check new domain closures against the inventory, preserving protected siblings and conditional controls when a parent is editable. No generic setter may write a protected attribute through its parent.

5. Add the compatibility rule to root AGENTS.md and describe field/domain onboarding in the settings guide. Require a stable key, shared validation and owner mutation, an explicit access policy or reason, and a coverage check for every new setting. Use the comparison pattern in test/settings-backup-coverage.test.ts, while keeping backup semantics independent. Fail on new undeclared control/field additions, including generated controls. Pending exceptions during rollout are an exact Phase 3 inventory, never an open-ended exemption.

## Verification and exit

Through the real dispatcher, introduce a test-only eligible field in an existing fixture owner and demonstrate find/get/set with zero MCP code or schema changes. Compare serialized tools/list input schemas for a small and a much larger fixture catalog; require identical bytes for mission_settings and exactly one new tool relative to the pre-feature tool set. Exercise cursor pagination, bounded large-value handling, stale tokens, concurrent edits, idempotent retries, invalid composite updates and preservation of siblings.

Run node --test --import ./test/setup-state.mjs --import tsx with the new contract and owner specs, test/settings-search.test.ts, test/settings-backup-coverage.test.ts and the Phase 1 MCP suite. Extend Playwright through a genuinely different owner, checking the live dashboard and reverse read after a dashboard edit. Run npm run typecheck, npm run lint, npm run build, npm run smoke, npm test and npm run test:e2e. Merge with all typed-owner rows complete and every remaining row assigned to Phase 3.

## Handoff and cross-phase audit

Phase 3 inherits the same tool definition, current-value semantics, conditional write token, access checks and bounded notification path as Phase 1. It adds only remaining owner behavior and completes the coverage guard. Audit against Phase 1 confirmed no new operation is necessary for conditional set or paged discovery. The AGENTS.md rule applies immediately to additions during Phase 3.
