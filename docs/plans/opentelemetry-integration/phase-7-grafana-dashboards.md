# Phase 7: six Grafana dashboards and local operator experience

## Outcome and value

Deliver the six promised dashboards on a reproducible local Grafana/Prometheus installation, with real application data, exact cohort summaries and working trace drill-down. An operator can start the stack, connect Mission Control and immediately use the provisioned views; a separate synthetic demo supports evaluation and testing.

Read [the source plan](plan.md), [the index](phased-plan.md), [P5](p5-analysis-delivery/plan.md) and the Phase 5/6 handoffs. Follow this proposed route while adapting implementation details to current code and explaining deviations in the PR. Working dashboards are a fixed outcome.

## Entry, dependencies and scope

Direct prerequisites: Phases 5 and 6 both merged, plus the planning PR. Repository: Mission Control only. The Phase 1 local reference stack and compatibility panel, Phase 5 action manifest and Phase 6 analytical query contract must be operable. No other repository or hosted product service is included.

Own all six dashboard definitions, provisioning/navigation, real PromQL and recording rules, Tempo search/trace links, local demo/operator setup, final reference-stack configuration and cross-system acceptance. This phase builds visualizations and their integration, not just validation reports. Earlier phases retain responsibility for their source semantics, migrations, privacy and behavioral tests.

## Inherited contracts and repository fit

Grafana/Prometheus is the selected local metrics experience; Phase 1 pins the compatible Collector/Tempo topology. Dashboard IDs, supported metric names/resource labels and versioned source/projection contracts come from the merged handoffs. Reuse `observability/` paths and stack scripts already introduced rather than create a second setup.

P5 supplies the detailed panel inventory and eight-review/six-run fixture. Exact cohorts are Phase 6 gauges; Prometheus counter trends can extrapolate and must be labeled accordingly. Core metric denominators never come from trace sampling. Every visible Grafana behavior receives Playwright coverage under `e2e/`, following the repository's fake-agent/accessibility rules.

## Implementation sequence

1. Build a panel manifest mapping question, source events/metrics, query, units, supported filters, expected fixture values, coverage/freshness state and test. Reconcile it with the Phase 5 action manifest and Phase 6 query contract. Required panels cannot ship as unexplained placeholders.
2. Provision stable data-source UIDs, a Mission Control dashboard folder, shared navigation and six maintained definitions under `observability/grafana/`. Keep definitions or their generator as the source of truth, not manual UI edits or copied exports with unstable IDs. New installation needs no manual dashboard/data-source import.
3. Deliver **Adoption and first value** (`mission-adoption`): active observed installations, successful feature/action use, first observed success, repeat use, task-kind/dispatch/completion/PR funnels. Distinguish first observed from first-ever and installation from person.
4. Deliver **Workflow completion** (`mission-workflows`) and **Human involvement** (`mission-interventions`): started/pending/completed/cancelled/unknown, stage duration/waits, repair rounds, horizon completion, required/recovery/steering/termination actions, recovery incidence and automation-eligible human-free completion. Use matching cohort/coverage snapshots; never substitute resume clicks for distinct affected runs.
5. Deliver **Persona quality and burden** (`mission-personas`): executed pass/fail volumes/rates, reason/basis, invalid/reused results, next-review resolution and bypass/directive signals. Keep reviewer model separate from author model and show volume/unknown share beside rankings.
6. Deliver **Models and effort** (`mission-models`): effective model/effort/runtime/terminal use, latency/tokens/attributed cost, author-at-submission outcomes, reviewer comparisons and mixed/unknown share. Honor each specialized view's dimensions rather than join every session attribute onto all metrics.
7. Deliver **Reliability and data quality** (`mission-reliability`): safe error families/components, affected-operation/install summaries, per-profile queue age/bytes/drops/failures, restart recovery, stale exports, incomplete context and late-data coverage.
8. Implement real PromQL/recording rules and test them with pinned Prometheus tooling. Define explicit zero/empty/NaN/incomplete/stale display behavior, aligned numerator/denominator filters and snapshot-coherence checks. Expose time/environment/installation scope and view-specific model/persona/workflow/task/version filters only where supported. No global filter silently leaves panels unfiltered.
9. Wire Tempo search and trace-ID drill-down for representative workflows/reviews/errors, with event-time model/stage context and safe attributes. Test actual trace content and historical search after an outage. Add metric exemplars only if Phase 1 proved the path; lack of exemplar support does not remove required trace navigation.
10. Finish local start/readiness/stop/restart/reset commands, isolated real/demo projects and persistent volumes. Document tested versions/architectures, host versus container addresses, credentials, per-service storage/retention and troubleshooting. Normal stop preserves data; reset is explicit. The optional stack never becomes an Electron/app-start dependency or silently enables product sharing.
11. Execute the full P5 dashboard acceptance scenarios through real application source paths with fake agents. Keep fixture seed/replay reproducible and isolated; do not seed only final chart values. Publish measured daemon overhead and backend-stack resource/query/recovery budgets separately, and document remaining platform/coverage limits.

## Data and compatibility

Reuse the merged source and analytical catalogs. A required missing signal is a source defect to fix with its owner and tests, not a dashboard-side redefinition of the metric. Preserve consent/profile isolation, bounded labels, historical event time, version semantics, zero versus unknown, and late/out-of-order acceptance policy from Phase 1.

No Prometheus per-run/date labels, SQL connection into the operator database, raw transcript/feedback content or public ingest deployment. Cross-installation panels accept multiple explicitly opted-in producers in the local fixture and report incomplete/stale producer coverage; they do not invent active users from one installation.

## Tests and verification

Validate provisioning/definitions and recording rules with the pinned stack tooling. Add browser coverage for all six dashboards, panel presence/results, supported filters, empty/zero/stale/unknown states, shared navigation and actual trace lookup. Use `e2e/` and fake agents; inspect rendered screens rather than only dashboard JSON.

Run the P5 six-run oracle through the app and backend. Assert 8 executed reviews/2 rejects, 4 completed/1 pending/1 cancelled, confirmed recovery 1 of 6 and known human-free R2 only. Check coherent calculation metadata and appropriate exact versus extrapolated panels. Include late PRs, mixed/pending effort, pre-opt-in sessions and multiple installations.

Stop the entire stack while generating actions, restart Mission Control, then restore the stack and verify unchanged counts/original-time traces. Independently stop Prometheus, Tempo and the Collector to prove durable handoffs and non-starvation; test duplicate ambiguous ACK, maximum supported late age and visible rejection beyond it. Restart all services without reset and verify persisted history, UIDs and links.

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`, the focused Grafana/telemetry Playwright specs and the reproducible local-stack integration command. Use the root `AGENTS.md` isolated unit command for any source/projection fixes. Capture screenshot/test evidence outside Git and attach durable proof to the PR. Do not claim a skipped real-stack/browser check passed.

## Merge, exit and handoff

Exit with all six dashboards populated from actual pipeline output, runnable queries, correct filters and trace navigation, isolated demo/setup documentation, persisted local service data, end-to-end restart evidence and measured limits. Tests/docs alone, a mock screenshot or an unqueried OTLP ACK do not satisfy this phase.

The repository now delivers the approved local/client integration. Other OTel backends remain possible through the same documented signals; public product hosting remains separately scoped. Maintain dashboard UID/name contracts and source/query ownership so future updates can be compared honestly.

Open the reviewable PR, resolve valid scoped feedback and current-main conflicts, and report CI/review/merge state. No further cleanup-only phase is needed to make this state operable.

## Cross-phase audit

2026-09-13: re-read the source, index and Phases 1-6. Both parallel inputs are direct prerequisites. The dashboard phase reuses the existing local stack and exact analytical projection; it does not create a second ingest pipeline or infer cohorts from sampled traces. Every P5 dashboard and user-selected local deployment has an implementation step and an executable acceptance path. Each introducing phase still owns its source/behavior tests and documentation.
