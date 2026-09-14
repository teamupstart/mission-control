# Phase 2: export profiles, consent and Settings

## Outcome and value

Let an operator collect locally without a server, configure user-owned export and independent product sharing, and understand retained data and delivery failures. The Settings experience controls the real durable facility introduced by Phase 1.

Read [the source plan](plan.md), [the index](phased-plan.md), [P0](p0-data-contract/plan.md), [P1](p1-durable-export/plan.md) and [P4](p4-interactions-errors-settings/plan.md). Follow this proposed route where the repository agrees, adapting with judgement and recording reasons in the PR. The requested behavior and inherited contracts remain fixed.

## Entry, dependencies and scope

Direct prerequisite: Phase 1 merged, plus the planning PR prerequisite. Repository: Mission Control only. The durable adapter, profile fencing, health types, public API extension seam and local-stack fixture must already pass their checks.

Own local capture and per-profile enable/disable/pause/retry/purge/reset, endpoint and credential handling, synthetic connection tests, settings restoration behavior, the browser Settings UI and bounded live health. Own the shared browser operation-context/typed ingress boundary used later. Record telemetry-control actions through the existing facade. Broad feature navigation/errors belong to Phase 5; session/workflow source hooks to Phases 3/4; product-server deployment is outside scope.

## Repository findings and inherited contracts

`src/shared/app-config-entries.ts` classifies settings/derived/operational values. `src/server/settings-backups/` restores settings. `src/server/settings-status.ts` and Registry's comparison publish a bounded status tuple; `src/web/useEventStream.ts` handles it exhaustively. `src/web/lib/settings-registry.ts` already has a Cost section mentioning telemetry, so distinguish application observability from Claude cost ingest without breaking the existing controls.

HTTP mutations use schemas in `src/shared/protocol.ts` and `parseBody`. Browser actions use `src/web/lib/api.ts`. Keep attribution metadata separate from auth decisions. Respect existing modal inset and accessible selector rules in `e2e/README.md` and root `AGENTS.md`.

## Implementation sequence

1. Finalize the minimal Phase 1 configuration into explicit local capture and independent user/product export state. Retain default-off behavior and per-profile consent/endpoint generations. Document combinations and transitions before wiring controls; an unenrolled product service is unavailable, not silently redirected to the user's backend.
2. Add validated read/update/state/test/retry/purge/reset operations through the Phase 1 telemetry router/module. Use revision checks where settings can race. Reuse the facade for writes and return small status objects; do not expose queue payloads or credentials in API/SSE.
3. Choose credential references/storage compatible with daemon-only and packaged modes using existing mechanisms where available. Keep secrets out of ordinary app configuration backups, logs, diagnostic errors and child environments. A config read exposes only whether a secret is configured. Require HTTPS for credential-bearing non-loopback exports in both daemon validation and the form, while allowing loopback HTTP Collectors. Endpoint changes do not silently transfer backlog or forward credentials on redirects.
4. Integrate status into the existing bounded snapshot/SSE channel and comparator. Update shared wire types, Registry comparison, settings status provider, client handling and necessary Settings registry/search metadata together. Do not add browser polling or duplicate stores for queue state.
5. Build the Telemetry Settings section: local-only, healthy, offline, paused, invalid credentials/configuration, loss/incomplete coverage, and off. Show per-profile pending count/bytes/oldest age and last accepted export. Distinguish queued, saved locally and delivered; local saved means committed.
6. Implement explicit backlog policy on destination changes, profile-specific purge and identity reset. Consent withdrawal stops new product sends and purges unsent product state without touching sessions/workflows/usage or the user profile. Restoring settings on another installation must not enable collection/sharing or restore identity/credentials implicitly.
7. Add app-issued logical operation context to relevant browser requests and a strictly typed bounded browser-only telemetry ingress. Preserve existing request IDs; acknowledge an ingress record only after durable commit. Unknown/declared actor basis stays visible, and metadata never grants authority. Phase 5 will add the broad signal callers.
8. Update user configuration/observability guidance and the local-stack connection steps. Make synthetic connection probes clearly distinct from real buffered history and avoid recursive telemetry of export attempts.

## Data, API and compatibility

Use Phase 1's profile store; no parallel consent/config source. Any additive config/migration belongs beside its upgrade and backup classification. Old installations remain off. The typed ingress has event-specific allowlists and bounded bytes/rate/buffer; rejected telemetry does not fail an otherwise successful application action. Preserve the original Claude `/v1/metrics` and Cost Settings behavior.

Actor context carries operation ID, surface, basis and causal link, not a trusted free-form `human` assertion. Do not change existing authorization checks while adding attribution. The wire contract and source/projection extension points are documented for later hooks.

## Tests and verification

Focused tests cover transition tables, same-operation replay, oversized/malicious ingress, endpoint generations, duplicate configuration updates, credential redaction, independent failures and settings restore. Use the mandated root `AGENTS.md` runner for relevant existing `test/settings-status.test.ts`, backup/restore tests and new telemetry profile/route tests.

Validate remote HTTP plus credentials is rejected consistently by the form and API, loopback HTTP remains usable, and redirect handling cannot send credentials to another destination. Keep the Phase 1 exporter checks as the final enforcement boundary.

Add Playwright coverage for every visible control/state, including local-only capture across daemon restart, separate opt-ins, paused versus disabled, connection probe, keep/discard backlog, purge/reset, secret masking and offline status. Use fake agents and accessible selectors; every new modal uses the inset helper.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, then the focused specs with `npm run test:e2e -- e2e/specs/telemetry-settings.spec.ts` or the actual spec names introduced. Run Phase 1's reference-stack smoke with both isolated profiles, keeping product fixtures separate from real data. Capture current UI evidence outside Git.

## Merge, exit and handoff

Exit with the documented profile matrix operable in Settings, durable local-only behavior, enforced consent/restore boundaries, no exposed secrets and passing focused tests. The app works when telemetry is off, refused or disconnected.

Phase 3 inherits the operation-context and immutable snapshot interface plus complete user controls; it adds session facts without redefining consent. Phase 5 inherits the typed ingress and browser context rather than adding another endpoint. Broad behavioral instrumentation cannot begin until this phase merges.

Open the phase PR, keep it compatible with current main, address valid scoped feedback and complete its verification. Its merge releases Phase 3; do not merge without the applicable authorization/review gates.

## Cross-phase audit

2026-09-13: re-read the source, index and Phase 1. Durable storage and default-off fencing remain in Phase 1; this phase owns their UI/API operations and typed ingress. No duplicate exporter, secret store or action identity is introduced. Registry/SSE edits finish before Phase 3 touches lifecycle hooks. Source control actions owned here are excluded from Phase 5's success-counter hooks.

Review reconciliation: validation and user-facing endpoint behavior mirror Phase 1's credential-bearing remote HTTPS and redirect contract. The supported local HTTP setup and independent consent semantics are unchanged.
