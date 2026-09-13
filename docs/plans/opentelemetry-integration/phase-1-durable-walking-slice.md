# Phase 1: durable telemetry walking slice and local reference stack

## Outcome and value

Give the opted-in daemon a working durable telemetry path: an application diagnostic is captured once, survives a restart without its backend, then appears as a metric and trace in a reproducible local Grafana/Prometheus stack. This is an operable foundation and compatibility proof, not a throwaway experiment or a claim that broad action coverage is complete.

Read [the source plan](plan.md), [the implementation index](phased-plan.md), [P0](p0-data-contract/plan.md), [P1](p1-durable-export/plan.md) and P5's [reference stack](p5-analysis-delivery/plan.md) first. The phase is a proposed route; adapt to the repository and explain deviations in the PR while preserving the requested outcome and cross-phase contracts.

## Entry, dependencies and scope

Direct prerequisite: the planning PR is merged and these paths exist on the implementation base. Repository: Mission Control only; no additional repositories. Baseline inspected: `16369e60`.

Own the shared domain/metric contract, bounded capture/projection/outbox, initial daemon lifecycle diagnostic, consent fencing/default-off configuration, public OTel adapter, local reference stack and one working diagnostic panel/trace. Provide separate source and analytical registration boundaries for later phases. Full Settings UX belongs to Phase 2; session/workflow/action catalogs gain actual callers in Phases 3-5; six product dashboards belong to Phase 7. No production backend deployment, broad auto-instrumentation, paid model calls or manually written OTLP codec.

## Repository evidence and inherited rules

- `src/server/index.ts` acquires state ownership and opens the database before serving, and closes it during shutdown. Attach bounded capture lifecycle here without making backend availability a launch/exit condition.
- `src/server/db.ts` has a schema revision, recovery backup, append-only migration path and synchronous writer. `src/server/workflows/store.ts` opens explicit transactions. Choose a telemetry store with clear transaction ownership; no nested generic writes or worker SQLite access.
- `/v1/metrics`, `src/server/usage.ts` and `src/server/spend-ledger.ts` already serve cost ingest. They are not outbound export and must continue working independently.
- `package.json` has no declared general OTel SDK. Pick public supported packages and pin the tested versions. The upstream resource-replacement issue in P1 is a prototype question, not permission for internal SDK imports.
- Current config classification and HTTP validation live in `src/shared/app-config-entries.ts` and `src/shared/protocol.ts`. Shared code must stay browser safe.

## Implementation sequence

1. Turn P0's envelope, context/resource, actor basis, action identity, audience and metric-view rules into a typed registry. Define browser-safe contracts under an appropriate `src/shared/telemetry*.ts` seam and daemon-only services under `src/server/telemetry/`. These are proposed new paths, not existing APIs. Include all declared feature groups and extension rules; forbid arbitrary attribute spreads and high-cardinality IDs on metrics.
2. Implement bounded default-off capture and per-profile eligibility/identity/endpoint generations. A minimal validated configuration/API supports local-only and isolated test endpoints so the walking slice is operable before Settings lands. Secrets are excluded from payloads and normal config snapshots from the first commit. Do not present an unenrolled public product destination as ready.
3. Select the persistence mechanism through an executable migration/crash fixture. Implement journal, immutable context, source dedupe, versioned projection state/checkpoints, immutable output batches and independent delivery state. Capture success means commit. Record the exact pre-capture loss/reconciliation boundary and prevent network I/O inside owner transactions.
4. Implement source and projection registration as separate extension seams, including bounded versioned reducer state and atomic checkpoints. Freeze the foundational API and ordering rules before consumers. Preserve original resource/version/timestamps and trace IDs; never replay journal events into live counters twice.
5. Implement the supported OTel serializer/export path and retry state machine. Cover full/partial success, retryable ambiguity, auth/config/payload failure, stale leases, expiry, quota and clean shutdown. Keep one destination's failures from blocking another; fence changes in consent/endpoint generation. Exclude outbound exporter environment/credentials from child agents.
6. Add an opted-in daemon diagnostic/start observation and a synthetic connection probe using this actual capture path. Expose bounded health/readiness through a validated local API for the walking slice, with types ready for Phase 2. Do not recursively count exports as user activity.
7. Build the minimum `observability/local/` reference stack: pinned Grafana, Prometheus, Collector, proposed Tempo and whatever local storage the chosen release needs. Provision data sources and one diagnostic dashboard. Bind host ports to loopback, persist backend/Collector queues and distinguish host from container addresses. Supply isolated fixture start/stop/reset commands, a readiness check and a documented OTLP endpoint.
8. Prove the real receiver/backend path with cumulative counters/histograms and completed spans, historical resources, duplicate batches, supported late age and original-time trace search. Pin translation/resource promotion and expose rejection limits. Measure candidate latency/byte/series/retention budgets and decide the seven-day payload plus bounded cohort-state lifetime together. Record the measured choice in a durable technical ADR/guide, not an uncommitted report.

## Data, API and compatibility contract

Add migrations beside the existing upgrade path and maintain schema revision/recovery behavior if using the app database. A separate telemetry file is daemon-owned and requires its own safe version/upgrade lifecycle. Choose based on the tested physical envelope; record why. Existing operational data and settings must open unchanged, with collection off.

Use one facade for `capture`, immutable context snapshots, source reconciliation and named projection registration. Exact method names are implementation choices. Define ordering/idempotency/acceptance, state-version migration and backpressure in tests. Later analytics must use this store rather than add a competing DB writer. Keep payload retention distinct from bounded minimal reducer/dedupe lifetime and charge both to the total budget.

Source hooks see accepted/refused/disabled results, not exporter exceptions. A telemetry storage failure does not rewrite a successful business result. Endpoint ACK is not backend query success; durable Collector forwarding must close its own post-ACK crash window.

## Tests and verification

Add focused durability/serialization/privacy/migration fixtures under `test/` and an isolated real-stack integration entry point. Use root `AGENTS.md` for the mandated unit test command. Cover every P1 crash boundary, two destinations, pre-consent history, partial success, poison batch, repeated replay, expiry/full disk simulation, historical resources and controlled shutdown. Existing `test/db-isolation.test.ts`, migration tests and cost-ingest/usage tests relevant to touched paths remain passing.

Run `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke`. Validate Compose configuration with the pinned tooling. Run the isolated backend command this phase adds, plus a Playwright spec for the provisioned diagnostic panel and working trace navigation. The real-stack test uses temporary state/fake agents and verifies queries, not merely HTTP acceptance. Document measured costs and unverified platform coverage.

## Merge, exit and downstream handoff

Exit only with a restart-safe accepted record replayed into a visible diagnostic metric and searchable trace, passing focused checks, upgrade/default-off safety, measured initial budgets and supported public adapter path. If the adapter fails, choose and prove another durable mechanism within this phase; do not merge an in-memory substitute and release dependents.

Later phases inherit the facade, registry policy, per-profile fencing, projection extension/state protocol, explicit registration seams, names/translation, local-stack fixture and error/health vocabulary. They add source coverage and UI through these seams. They may not change acceptance, writer ownership, original-time attribution or the zero-leak defaults casually.

Open a reviewable PR, resolve valid scoped feedback/conflicts and leave the branch green. Its merge releases Phase 2. Merge permission follows the operator/repository policy; opening this phase does not grant it.

## Cross-phase audit

2026-09-13, dependency-order audit: reconciled source P0/P1/P5 with the index. The full durable boundary stays in Phase 1; Phase 2 adds control UX instead of repairing unsafe defaults. Namespaced projection state anticipates Phase 6 without requiring a later common migration. The local stack proves the user-selected backend early and remains independent of Electron packaging. No earlier phase exists to amend.
