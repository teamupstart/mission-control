# Phase 3. Specialized owners and complete coverage

A session can use the same compact tool for every ordinary Mission Control setting, including settings with specialized owners. Discovery explains which controls need an operator, and the inventory test detects future coverage gaps.

## Entry and scope

Repository: Mission Control. Direct prerequisites: the planning session and merged Phase 2. Phase 1 is transitive. Read plan.md, phased-plan.md, the completed typed-owner inventory and its remaining named rows. Close all outstanding controls and editable leaves. Preserve existing owner-specific validation, operator authority, public keys and compact wire contract.

## Implementation order

1. Resolve each residual row against the Settings panel and backing code. Start with src/web/lib/settings-registry.ts and settings-search.ts, including Setup, Feature flags, Trust, Telemetry, Restore, pipeline integrations, conditional Voice and Shaping panels, generated per-flag rows, and any owner outside app_config. A backup-excluded record can still contain an operator preference. A backup-included record can still carry protected data. Review the entire remainder, including fields within composite controls. A bulk domain label is insufficient.

2. Make owner adapters that call the same live mutation services as the corresponding dashboard controls. Feature flags, for example, use FeatureFlagIntentSchema and applyFeatureFlagIntent, which gives master and individual switches different effects. Expose only legal individual intents with owner authorization. Protect the rollout flag, permission settings, bulk override changes and all indirect paths to protected state. Check new feature flag definitions against the same policy. Cover feature-disabled, unavailable and conditional choices. Maintain existing confirmation, private Electron or operator-only pathways for actions that require them.

3. For operational actions such as restore, and statuses or secrets displayed in Settings, give a specific access disposition. Protected discovery can name the destination; any read result must be safe to disclose. No secret values, sensitive nested siblings or executable/grant-bearing changes may leak through get, set, find, logs or error details. For external or per-window storage, identify its real owner, durable location and target. Implement ordinary preference mutations there or establish an explicit target using the existing contract. If a genuine ordinary preference cannot be supported, report the exact gap and resolve it before claiming complete coverage.

4. Reuse owner events and extend missing refresh handling through Phase 1’s SSE path. Keep signed-caller enforcement and check at write time for asynchronous owners. Honor live session eviction, disable/re-enable, owner-side validation failures, and side effects such as reconfiguration that a raw database update misses. Test retries and races with a human edit. Explicit protected classifications must identify an existing authority or operational reason, rather than functioning as a shortcut for a missing adapter.

5. Remove the temporary named pending inventory when all rows have a working ordinary read/write or a justified protected, derived or operational disposition. Enforce total coverage in CI using normal repository tests. Update README and settings/feature flag guides with the final supported behavior, access switch, reasons for protected results, and a brief Daylight example. Keep agent instructions limited to the contributor rule and a short tool description.

## Verification and exit

Exercise an eligible specialized intent through its production service, including current-state readback and visible dashboard update. Test gated domains, protected fields within writable objects, bulk flag/reset routes reachable via the tool, consent-bound settings, error and logging redaction, per-owner result bounds and failed partial writes. Verify a new setting inside an onboarded specialized owner inherits discovery through its declared descriptor. Include a failure fixture for an undeclared setting and exhaustively join dynamic controls, editable leaves and dispositions. The final inventory must have zero pending rows.

Run node --test --import ./test/setup-state.mjs --import tsx with the added owner/coverage tests plus test/settings-search.test.ts, test/settings-backup-coverage.test.ts and the cumulative MCP settings tests. Run the Phase 1 and 2 browser specs alongside Playwright coverage for the newly supported behavior. Verify with fake Claude, Codex and Pi sessions. Run npm run typecheck, npm run lint, npm run build, npm run smoke, npm test and npm run test:e2e; preserve the preload, browser and Electron prerequisites in AGENTS.md. Register representative evidence from the final runs.

Merge when the coverage guard and production call paths demonstrate all ordinary settings, protected boundaries, durable opt-out and a constant tools/list definition. The final state requires no additional implementation phase.

## Handoff and cross-phase audit

Phase 3 consumes the generic owner descriptors and conditional writes from Phase 2 and the Phase 1 auth, rollout and SSE contracts. Feature flag writes use the intent owner, and workstation, credential and confirmation actions retain their existing authorities. Audit reconciliation: a control can point to several settings or no durable preference at all; completeness is checked at both control and leaf level. The only later handoff is ongoing ownership through the AGENTS.md rule.
