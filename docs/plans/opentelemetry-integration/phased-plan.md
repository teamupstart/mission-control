# OpenTelemetry implementation phases

Source: [approved design](plan.md), including its [six detailed areas](plan.html). Implementation baseline inspected: `16369e60` on 2026-09-13. The operator requested the phased-plan skill and scheduling all implementation work. The P0-P5 names identify design areas; the seven numbered phases below are independently reviewable implementation units.

## Incorporated decisions

- Collect primary-action, session/model/effort, workflow/stage/persona, intervention, error and verified outcome telemetry as metrics and traces.
- Support local capture without an endpoint and restart-safe retention after durable acceptance in the first usable release.
- Support user-owned and minimized product export profiles with independent opt-ins and identities.
- Build six real dashboards on local Grafana/Prometheus. Use a local Collector and Tempo as the proposed routing/trace companions, validating their versions/topology in Phase 1.
- Schedule implementation now. Every phase waits for this planning PR to merge, as well as its direct phase prerequisites.

Scope is this Mission Control repository only. The client and local reference stack support both audience policies. Deployment of a public product-ingest service remains separately scoped in the approved design; this sequence does not invent an external repository, hosting account or production endpoint. Product enrollment unavailable in an installation is displayed honestly and tested with an isolated local receiver.

## Repository findings and reconciliations

| Verified source | Consequence for the implementation sequence |
| --- | --- |
| `package.json`; `src/server/routes.ts` `/v1/metrics`; `src/server/usage.ts`; `src/server/spend-ledger.ts` | Existing OTel is inbound cost ingest. Add the general outbound facility separately and consume the canonical usage ledger once. No general OTel SDK dependency is declared today. |
| `src/server/db.ts` startup backup/schema revision, synchronous writer and WAL; `src/server/workflows/store.ts` transaction helper | Phase 1 owns telemetry migration/transaction policy and versioned projection storage. Never nest an arbitrary telemetry transaction inside workflow writes or let a worker write SQLite. |
| `src/server/index.ts` database opening and shutdown | Initialize capture after state ownership; complete bounded local work before database close; network availability cannot delay exit indefinitely. |
| `src/shared/app-config-entries.ts`; `src/server/settings-backups/`; `src/server/settings-status.ts`; Registry settings-status comparison; `src/web/useEventStream.ts` | Consent, credentials and derived queue state need explicit classification. Phase 2 owns their complete API/SSE/Settings integration and restoration behavior. |
| `src/shared/types.ts` SessionMeta/pendingEffort; effort route; SDK/Registry owners | Phase 3 freezes event-time effective attribution, including pending-next-turn effort and missing observations. Configuration is not evidence of execution. |
| `src/shared/workflow.ts`; workflow engine/store; `src/shared/workflow-stages.ts`; `src/shared/workflow-lifecycle.ts` | Phase 4 preserves executed versus reused verdicts, actual execution model, decoded waits and projected stage occurrences. It adds observation, not another workflow engine. |
| Current main `16369e60`, `docs/workflows.md`, evidence preflight tests | First-round evidence attempts were doubled after the original design baseline. Telemetry must observe the current budget and distinguish evidence attempts from semantic reviews; it must not restore the older behavior. |
| `src/server/registry.ts` eviction and `src/server/tasks.ts` departure handling; work-episode/PR persistence | Session removal, task outcome and verified per-repository PR facts remain distinct. Unknown completion cannot be exported as proven failed work. |
| `src/server/db.ts` `invalidateTaskOwnershipInTransaction`; `mergedPrFor`; `taskPrPollTargets` | Invalidation drops bindings without archival. Phase 3 retains bounded observation-only PR context and shares daemon polling so late delivery survives removal without broadening operational task completion or selection-time dependency release. Phase 6 verifies cohort revision from those facts. |
| Browser API, action owners, MCP and worker boundaries | Phase 5 completes an explicit action manifest. HTTP retries and SSE replay cannot become extra logical actions; caller provenance is not authorization. |
| `e2e/README.md`, fake-agent fixtures and `AGENTS.md` | Every new visible surface gets Playwright coverage with fake agents. Unit tests use the repository's mandated isolated runner. No tests may touch operator state or spend model tokens. |
| Mission Control `/mcp/tasks` implementation and live read-only task inventory | Task creation supports durable prerequisite edges and resolves this worktree to the canonical Mission Control checkout. No existing OpenTelemetry implementation tasks were found before scheduling. |

These are verified code/document observations. SDK replay behavior, seven-day backend ingestion, physical storage overhead and performance are unproven and belong to Phase 1's compatibility gate. Candidate limits from P0/P1/P5 remain measured design targets. An unsuccessful prototype cannot release consumers against an in-memory substitute or an undocumented adapter.

## Size and phase-count rationale

Estimate: **7,500-12,300 gross non-test implementation lines**, including TypeScript, SQL/migrations, Compose/provisioning, Prometheus rules and dashboard definitions; excluding tests and explanatory docs. This is a sizing signal, not a delivery promise. It assumes maintained public OTel components, reuse of current owners and generic dashboard definitions, no new hosted service, and no hand-written OTLP codec. Generated dashboard JSON can materially affect the count; count either its maintained source or the material definition, not both.

| Phase | Non-test lines | Why this separate merge boundary is warranted |
| --- | ---: | --- |
| 1. Durable walking slice and local reference stack | 1,800-2,600 | Resolve adapter, transaction, restart and backend uncertainty before many owners depend on them. A live daemon diagnostic reaches a provisioned panel and trace. |
| 2. Export profiles, consent and Settings | 700-1,100 | Complete the user control surface and failure states before adding broad behavioral capture; combining it with storage/protocol proof makes the first change too broad. |
| 3. Session, model and outcome telemetry | 700-1,150 | Session identity, pending effort, usage and late PR outcomes form one coherent lifecycle slice with substantial regression exposure. |
| 4. Workflow stages, verdicts and recovery | 900-1,500 | Graph/review/delivery semantics and evidence-budget compatibility need their own source-owner review; they consume Phase 3 attribution. |
| 5. Primary actions, automation and errors | 1,000-1,800 | The remaining 21-group coverage audit spans UI/MCP/worker owners; combining it with workflow semantics would obscure duplicate-event and actor regressions. |
| 6. Bounded analytical projections | 800-1,350 | Stateful cohorts and late outcomes require restart/retention validation independent of wide instrumentation. This exports useful OTLP summaries before dashboards land. |
| 7. Six Grafana dashboards and local operator experience | 1,600-2,800 | Provisioned visualizations, real PromQL/Tempo navigation and local-stack browser tests form a substantial deliverable beyond reducers. This is not a tests/docs-only phase. |

All layers needed for a phase's working behavior, tests and documentation land together. Seven phases are justified by protocol uncertainty, independently testable source semantics, stateful analytics and the separate visual deliverable, not by file count or one phase per application layer.

## Phase index and direct prerequisites

| Phase | Implementation guide | Direct prerequisites | Operable result |
| --- | --- | --- | --- |
| 1 | [Durable walking slice](phase-1-durable-walking-slice.md) | Planning PR | Opt-in daemon diagnostic, durable metrics/traces, local stack and a working compatibility panel |
| 2 | [Profiles and Settings](phase-2-profiles-and-settings.md) | Phase 1 + planning PR | Complete independent capture/export controls and bounded live health |
| 3 | [Session attribution and outcomes](phase-3-session-attribution.md) | Phase 2 + planning PR | Event-time session/model/effort, turns, usage, endings and PR facts |
| 4 | [Workflow insights](phase-4-workflow-insights.md) | Phase 3 + planning PR | Correct stages, reviews, reasons, repairs and human-recovery signals |
| 5 | [Actions, automation and errors](phase-5-actions-and-errors.md) | Phase 4 + planning PR | Full primary-action manifest, browser signals and correlated safe errors |
| 6 | [Analytical projections](phase-6-analytical-projections.md) | Phase 4 + planning PR | Restart-safe bounded cohort/retention summaries exported through OTel |
| 7 | [Grafana dashboards](phase-7-grafana-dashboards.md) | Phases 5 and 6 + planning PR | Six populated dashboards, trace drill-down, demo and operator setup |

```text
Planning PR merge is a direct prerequisite of every phase.
Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5 -> Phase 7
                                      -> Phase 6 -> Phase 7
```

Concurrency groups are `{1}`, `{2}`, `{3}`, `{4}`, `{5,6}`, `{7}`. Phases 5 and 6 can merge in either order. Phase 5 owns source/action/error/browser instrumentation and its coverage guide; Phase 6 owns analytical reducers, their catalog/registration subtree, focused tests and analytical guide. Neither edits the other's files or needs a new common migration. Phase 4 freezes the handoff before the fork. If implementation discovers a shared edit or missing contract, land the common change before either branch starts or revise the dependency edges before dispatch; do not preserve fictional concurrency.

## Cross-phase contracts

1. **Domain facts and context:** one versioned typed registry, immutable resource/context references, stable semantic event/operation identity and explicit actor basis. New semantic revisions are new facts; original timestamps and model context survive replay.
2. **Durability:** accepted means local commit. Bounded fail-open capture has a documented pre-acceptance gap. Projection/checkpoint/output commit together; delivery retries immutable batches. No repeated SDK increments on replay. Per-profile identities, consent epochs and endpoint generations never mix.
3. **Extension boundary:** Phase 1 supplies namespaced source and projection registration plus bounded versioned state/checkpoints. Phase 4 freezes source contracts used by both forked phases. Phase 5 adds callers and feature-local definitions; Phase 6 registers analytical reducers through a separate projection entry point. State migrations remain with the one daemon owner.
4. **Controls and privacy:** local-only needs no endpoint; disabling differs from pausing; ordinary settings restore cannot opt in; secrets and raw content never enter records. Product and personal export retain independent opt-ins, queues and failure handling.
5. **Source semantics:** effective versus pending effort, session versus task outcome, executed review versus invalid/reused response, and human recovery versus required approval remain separate. Evidence preflight budgets stay as current main defines them.
6. **Retention and completeness:** candidate seven-day payload retention and 30-day minimal cohort state share the bounded byte budget. Window/horizon and late-data limits are fixed together, with explicit unknown/incomplete states after gaps. No unbounded run IDs or date labels on metrics.
7. **Backend contract:** public supported SDK path; selected metric translation/resource promotion; historical timestamps; durable Collector queues; tested old-sample/trace search behavior. Prometheus activity trends and exact projected cohort snapshots have distinct meanings.
8. **Compatibility:** defaults off, additive migrations beside their upgrade path, append-only persisted IDs, no competing eviction/history system, no outbound environment leakage into agent cost ingest, no production deployment changes.

## Requirements ownership

| Source requirement or selection | Sole implementation owner | Consumers / verification |
| --- | --- | --- |
| P0 envelope, dimensions, schemas, identity, minimization and budgets | Phase 1 | Every phase; additive source definitions follow the same registry |
| P1 journal, projection/checkpoint, outbox, restart/retry and compatibility | Phase 1 | Phase 2 controls and Phase 7 end-to-end replay |
| P4 consent, endpoint controls, credentials, settings restore and live health UI | Phase 2 | All later sources; isolated product-policy fixture |
| P2 session/turn/dispatch/model/effort/terminal/usage/end/task/PR facts | Phase 3 | Phase 4 context and Phase 6 cohorts |
| P3 workflow/stage/persona/reason/delivery/repair/intervention facts | Phase 4 | Phase 5 shared action context; Phase 6 reducers |
| P4 remaining primary actions, navigation, automation and safe cross-layer errors | Phase 5 | Phase 7 coverage panels and real-action tests |
| P5 distinct-run, outcome-horizon, repeat-use and quality aggregation | Phase 6 | Phase 7 exact snapshot panels |
| P5 local stack baseline and version/OTLP proof | Phase 1 | Phase 7 owns expansion and operator packaging |
| P5 six real dashboards, queries/rules, trace navigation and final local setup | Phase 7 | Complete reference user experience |
| Verification of each phase's migrations, privacy, behavior and docs | That introducing phase | Phase 7 adds cross-system acceptance; it does not replace earlier checks |
| Hosted product service, account enrollment and production deployment | Explicitly outside this approved local/client sequence | Separate service scope required; no public sharing is silently enabled |

P4's action inventory is partitioned at operation level: telemetry controls belong to Phase 2; dispatch/conversation/session/model/end/PR facts to Phase 3; workflow/persona control to Phase 4; Phase 5 owns remaining actions and audits every inventory row without re-emitting those earlier facts. Phase 6 derives aggregate summaries only and cannot create a second source event for an action.

## Publication and scheduling

All seven tasks have been created and their durable dependency records verified. Open the [task schedule](schedule.html) for the phase-to-task-ID map and publication record.

Commit and push the approved source briefs, this index/HTML and all seven phase guides before creating any task. Verify each exact repo-relative path in the pushed commit. Every task gets `dependsOnCurrentSession: true`, plus only the direct task prerequisites shown above, using default agent/model/effort. Verify the returned canonical repository and persist the phase-to-task map in `schedule.md` after successful creation. No duplicate task is recreated on a timeout without checking its recorded result.

Open the planning PR, record the map in its description and wait for green CI. The operator merges the planning PR; no merge permission is implied by scheduling. Its merge publishes the paths and releases Phase 1. Subsequent phase PR merges release their dependents. The active planning task is `029710f7-b160-45dd-9080-955b2939dcfb`; use the MCP's current-session edge rather than copying that identity into task inputs.

The companion `report.html` is local investigation output and is never committed. Durable findings needed by implementers are in this index and the source briefs. Runtime data and visual/test evidence are also excluded from the plan commit.

## Verification strategy and complete-set audit

Use the focused files/scenarios named in each guide and the exact isolated unit-runner contract in root `AGENTS.md`; do not copy or weaken its preload command. Typecheck/lint apply to implementation; build/smoke to runtime surfaces; Playwright to every visible app or Grafana change. All agent calls are fake. Compatibility tests use isolated local services and temporary state, never live operator history.

Phase 1 proves durable metrics/traces through the reference stack; each source phase proves semantic identity and privacy. Phase 6 checks the six-run oracle and late/censored cohorts. Phase 7 drives real source actions through the same pipeline into all six dashboards, checks filters/zeros/gaps/trace navigation and restart-at-each-hop behavior, and publishes measured daemon and stack budgets separately.

Planning verification checks all referenced artifact paths, graph acyclicity/direct edges, complete ownership, concurrency write sets, Markdown/HTML consistency and offline desktop/mobile rendering. No passing runtime prototype is claimed by these documents.

Audit record, 2026-09-13: all seven guides were reviewed in dependency order against the source and previously written guides. The complete-set audit passes: each required source/delivery behavior has one introducing owner; consumers follow prerequisites; Phase 5/6 write sets and registration are separate; phase-specific tests stay with behavior; and the final state includes every required dashboard. Phase 6 explicitly checks snapshot coherence so Phase 7 cannot combine different calculations. No unconfirmed successful prototype is assumed: Phase 1's measured adapter/backend acceptance is a merge gate before consumers. Publication-path and rendered-artifact checks run before task creation.

Review reconciliation: P1/P4 and Phases 1/2 now state the same credential-bearing remote HTTPS and redirect contract. P5's design ownership is distinguished from implementation ownership in Phases 1, 6 and 7. The root reflects the seven scheduled tasks and links to the rendered repository findings. These clarifications preserve the dependency graph, restart-safe capture and concrete dashboard deliverables.

Late-outcome review reconciliation: P2 and Phase 3 explicitly cover ownership invalidation, durable observation-only associations and shared-poller routing. Phase 3 owns the source/retention fixture; Phase 6 owns final cohort revision. Existing historical bindings and operational completion/dependency rules retain their current authority. No phase edge or operational policy change is required.
