# P5. Local Grafana dashboards and end-to-end telemetry

Implementation scope for review. Parent: [planning brief](../plan.html). P5 builds the local observability stack and six working dashboards using the contracts and signals from [P0](../p0-data-contract/plan.html), [P1](../p1-durable-export/plan.html), [P2](../p2-session-lifecycle/plan.html), [P3](../p3-workflow-insights/plan.html) and [P4](../p4-interactions-errors-settings/plan.html). Validation supports these deliverables; it is not P5's only output.

Confirmed requirements: independent user-backend/product opt-ins, restart-safe capture of accepted core telemetry in the first usable release, and actual dashboards on a local Grafana/Prometheus installation. On 2026-09-13 the operator also requested scheduling. The [phased plan](../phased-plan.html) owns the implementation sequence; this design specifies the dashboard behavior.

## Concrete outcome

An operator starts the supplied local stack, selects its OTLP endpoint in Mission Control, performs application actions and opens six already-provisioned Grafana dashboards showing real metrics and linked traces. A separate synthetic demo mode makes the same dashboards useful for development and acceptance testing without paid model calls or private operator data.

P5 owns runnable stack configuration, version-controlled dashboards, PromQL/recording rules, trace navigation, any missing bounded analytical projections, fixture replay and browser/API checks. A document containing dashboard ideas or screenshots alone does not complete P5.

## Local reference stack

| Component | Responsibility | Planned implementation |
| --- | --- | --- |
| Grafana | Dashboard UI and trace exploration | Provision the Prometheus and Tempo data sources plus all six dashboards with stable UIDs |
| Prometheus | Metric storage and PromQL | Enable its OTLP metrics receiver; pin metric-name translation, resource-label promotion, retention and late-sample policy |
| OpenTelemetry Collector | One local OTLP ingress and signal routing | Route metrics to Prometheus and traces to Tempo using separate durable sending queues |
| Grafana Tempo | Trace storage and search | Proposed trace backend for the existing metrics-and-traces requirement; provision trace searches and links from Grafana |
| Mission Control daemon | Capture, source semantics and derived metrics | P1 owns durable capture/export; P5 adds analytical reducers through that facility when the dashboards need them |

The operator selected Grafana and Prometheus. Tempo and an upstream Collector are the recommended companion components. Prometheus documents an explicitly enabled HTTP receiver at `/api/v1/otlp/v1/metrics`, configurable resource promotion and late ingestion. Pin the translation policy and verify the emitted names. [Prometheus OTLP guide](https://prometheus.io/docs/guides/opentelemetry/).

Tempo provides trace storage/search and Grafana has a built-in Tempo data source. It supplies the trace side of this proposed stack. [Tempo tracing overview](https://grafana.com/docs/tempo/latest/set-up-for-tracing/). Grafana supports provisioning data sources and loading dashboard definitions from local files, which makes a repeatable installation possible. [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/).

Proposed data flow:

```text
Mission Control domain facts + bounded analytical projection
  -> P1 durable per-profile journal/outbox
  -> local OpenTelemetry Collector OTLP ingress
       -> metrics: Prometheus OTLP receiver -> Prometheus storage
       -> traces: Tempo OTLP receiver -> Tempo storage
Grafana queries Prometheus and Tempo -> six dashboards and trace drill-down
Version-controlled provisioning -> Grafana data sources and dashboards
```

Use a documented Docker Compose setup with pinned compatible images and persistent volumes. Include every storage dependency required by the selected Tempo release; do not assume a particular version can run as one self-contained process. D0 proves the smallest supported topology before its configuration becomes the reference. The stack is an optional local deployment, independent of Electron packaging and app startup. Mission Control continues capturing when the whole stack is stopped.

Expose operator-facing ports on loopback, use service names for container-to-container connections, and document the host endpoint separately. Keep data volumes, credentials and runtime output out of Git. Stopping/restarting preserves data; reset is a separate documented action. Demo and real-data modes use isolated projects/volumes and explicit environment filters. Local setup must not enable the independent product-sharing profile.

P1 remains responsible for records before the Collector acknowledges them. The reference Collector must persist an accepted batch until delivery to its backend or an explicitly reported retention/permanent-failure boundary. A default in-memory Collector queue would introduce a new loss window and is not sufficient. Validate each hop by stopping it independently.

## Deliverables to build

Proposed paths are implementation targets, not files already created by this plan:

| Artifact | Completion requirement |
| --- | --- |
| `observability/local/compose.yaml` and component configuration | Reproducible start, readiness check, stop, restart and explicit reset; pinned versions and documented local resource requirements |
| `observability/grafana/provisioning/` | Stable Prometheus/Tempo data-source UIDs and dashboard providers; no manual import or data-source editing |
| `observability/grafana/dashboards/` | Six maintained dashboard definitions, shared navigation, descriptions, units, variables and useful empty states |
| `observability/prometheus/` | Queries/recording rules, label translation contract and rule fixtures checked by the pinned Prometheus tooling |
| Daemon analytical projectors through P1 | Required distinct-run, horizon and repeat-use summaries; restart-safe checkpoints, bounded retention and P0-approved metric views |
| Synthetic source fixtures and replay driver | Exercise real P0-P4 capture/export paths with fake agents, deterministic clock and expected counts; never seed only the final chart values |
| `e2e/` dashboard coverage and backend assertions | Exercise Grafana panels, filters and trace navigation; query real Prometheus/Tempo to verify semantics |
| Local observability guide | Setup and connection steps, panel definitions, freshness/coverage limits, upgrade and troubleshooting instructions |

Each panel has a manifest entry connecting its question to source events, instruments, query, units, allowed filters, expected fixture result and test. If a required panel lacks a usable signal, P5 implements the missing projection or lands a coordinated owner change in P0-P4. An unexplained empty panel is not a delivered dashboard.

## Three analytical layers

| Layer | Good at | Not sufficient for |
| --- | --- | --- |
| OTel metrics | Bounded rates, counts, histograms, operational queue health | Arbitrary joins, unique users, exact abandonment or mutable cohort outcomes |
| OTel traces / approved outcome records | Individual causal sequences, model/reviewer context, per-run drill-down | Unbiased totals if sampled; unlimited retention or automatic SQL joins |
| Bounded daemon analytical projection exported as OTel metrics | Required distinct-run/install cohorts, horizon outcomes and repeat-use summaries | Arbitrary warehouse joins, unbounded histories or replacing app ownership |

Grafana/Prometheus is the selected reference. The app keeps an OTLP contract that other backends can consume. D0 checks this actual stack's replay, retention, historical samples/resources and trace search; a receiver success alone does not prove that a dashboard can find the data.

The required dashboards must work on the local reference stack. Compute nontrivial cohort facts from accepted domain events in a bounded daemon projection and export the results through OTLP. Grafana does not read the operator's SQLite database, and P5 does not require a SQL plugin or a separate warehouse. Arbitrary multidimensional retrospective analysis remains a possible later extension.

## Six dashboards to deliver

| Dashboard and stable UID | Required panels | Sources and queries |
| --- | --- | --- |
| Adoption and first value, `mission-adoption` | Observed active installations; successful actions by feature/surface/task kind; first observed successful action; repeat use; dispatch/completion and PR-production funnels | P4 actions, P2 outcomes and bounded installation/feature/cohort gauges; distinguish first observed from first-ever use |
| Workflow completion, `mission-workflows` | Started/pending/completed/cancelled/unknown; completion within horizon; stage wall/wait/execution time; repair-round distribution; early exits and PR outcomes | P2/P3 metrics, duration histograms and run/task cohort projection; distinguish task completion from session departure |
| Persona quality and burden, `mission-personas` | Executed pass/fail count and rate; rejection reasons; invalid responses/reused passes; next-review resolution; bypass/directive changes | P3 verdict/reason counters and next-review reducer; reviewer model and persona filters; trace search for examples |
| Models and effort, `mission-models` | Sessions and segments by effective model/effort/runtime/terminal; latency/tokens/attributed cost; author-at-submission outcomes; reviewer comparison; mixed/unknown coverage | P2 snapshots/usage plus P3 execution facts; separate author and reviewer panels using specialized P0 views |
| Human involvement, `mission-interventions` | Required/recovery/steering/termination actions; successful actions per run; distinct runs needing recovery; human-free completion; wait and action failures | P3/P4 actions plus bounded per-run flags and matured-cohort gauges; show unknown actors separately |
| Reliability and data quality, `mission-reliability` | Errors by family/component; affected-operation/install summaries; pending bytes/oldest age/drops; backend delivery failures; restart recovery; attribution gaps | P1/P4 health and error metrics, bounded affected-entity summaries, error trace search and late-data indicators |

Provide time range, environment and installation scope; add workflow family, persona, model/effort, task kind and version filters only where the metric view supports them. A global filter must never silently leave some panels unfiltered. Custom/overflow and unknown values stay selectable. Compare app/workflow revisions with bounded version views and traces for full revision context; avoid a full label cross-product.

Every panel documents its time/cohort basis, denominator, coverage and freshness. Distinguish genuine zero, no eligible observations, stale export and incomplete attribution. A local installation commonly shows one installation; cross-installation panels need multiple explicitly opted-in producers and must not invent unique users. Synthetic fixtures cover multiple producers. Use Tempo searches and trace-ID links; metric exemplars are an additional link mechanism only after the chosen exporter/receiver path proves them.

## Query definitions

| Measure | Exact definition | Qualification |
| --- | --- | --- |
| Executed rejection rate | Executed completed fail reviews / executed completed pass-or-fail reviews | Exclude reused/disabled results, infrastructure errors and cancelled attempts |
| Successful recovery actions per run | Successful distinct human recovery operation IDs / eligible started runs | Different from fraction of runs needing recovery |
| Manual recovery incidence | Distinct eligible runs with at least one confirmed successful human recovery / eligible started runs | Show ambiguous-actor runs and pending runs |
| Human-free completion | Completed eligible runs with zero observed human actions and sufficient observation continuity / eligible started runs | Separate workflows designed to require human gates |
| Completion within horizon | Runs completed within H of their start / runs with at least H elapsed since start | Retain pending/cancelled outcomes; use a declared horizon |
| First review pass | First executed semantic pass per run/node / first executed pass-or-fail reviews | Invalid response retry is not a new semantic first review |
| Repair resolution | Failed nodes with next executed review passing / failed nodes with a next executed review | Report “no next review” separately; this is not defect-identity tracking |
| PR production | PR-eligible tasks with verified new PR creation / eligible tasks with adequate visibility | Existing PR association and unknown visibility are separate |
| Feature repeat use | Installations with successful feature use in two declared periods / installations with feature use in the first | Subject to opt-in/identity continuity and retention |
| Cost per outcome | Attributed API-equivalent cost over the declared cohort / qualifying outcomes in that cohort | Show missing usage, unfinished work and author/automation shares |

Do not mix denominators between charts. A completion rate among only already-completed runs is always 100% and says nothing. A recovery count divided by finished runs excludes exactly the stalled work most likely to need improvement.

For time-window incident metrics, use events that occurred in the window. For start-cohort measures, follow runs that started in the window through a fixed horizon. These are different views and must be named accordingly. Recently started runs are immature; ones observed after opt-in with an earlier start are left-censored and excluded from start-based funnels by default.

## Metrics needed for the dashboards

P5 must implement the analytical summaries missing from P0-P4, through P1's daemon-owned projection interface. They consume the same accepted domain facts and checkpoint atomically. Run/session/operation IDs may key bounded local reducer state, but must not become Prometheus metric labels.

| Projection | State and output |
| --- | --- |
| Review population | Executed semantic review counts, separate invalid/reused counts, bounded persona/model/reason slices and first/next-review resolution |
| Run cohort | Start time/context, outcome evidence and first qualifying intervention flags; eligible/completed/pending/cancelled/unknown/recovery/human-free snapshot counts |
| Task/PR cohort | Eligible tasks, verified new PR creation and completion/early-exit evidence; preserve unknown and multi-repository coverage |
| Installation/feature activity | Per-epoch bounded feature activity buckets; first observed use, active/repeat-use indicators and matched cohort denominators |
| Attribution and errors | Known/unknown shares and distinct affected-entity counts within the declared bounded window; safe categories only |

Distinguish event counters from snapshot gauges. Proposed cohort instruments include `mission.analytics.runs.eligible`, `.completed`, `.with_recovery` and `.human_free`, all gauges over the same start cohort. They are not counters to which `rate()` should be applied. Separate gauges carry window start/end, horizon, calculated-at time and completeness; timestamps are values, not unbounded labels. Exact names and supported slices become P0 catalog entries before implementation.

Start with a bounded window catalog. Candidate defaults are a seven-day start window and seven-day outcome horizon: at calculation time T, eligible starts lie in `[T - 14 days, T - 7 days)`, and each run's outcome is evaluated at its own start plus seven days. Repeat feature use compares two adjacent seven-day windows. Only actions after the run start and at or before its horizon qualify. Compute observed recovery incidence and automation-eligible human-free completion as separate views with their own denominators.

These rolling summaries require more retained minimal projection state than P1's seven-day unsent-payload window. Candidate projection retention is 30 days, charged to the same total byte budget and consent policy. This covers the candidate windows plus late-event reconciliation; capacity/expiry gaps must mark a cohort incomplete. Finalize and measure the window/retention pair in D0. Do not retain full raw event payloads for 30 days merely to maintain small cohort records.

Late facts can revise the current calculated snapshot if their event time qualifies. A newly calculated snapshot has a new calculation time; this does not retimestamp the underlying events or rewrite already-exported historical samples. Historical cohort charts show what was known at each calculation time and disclose incompleteness. A stale producer cannot be silently treated as zero in a multi-installation rollup.

Prometheus counter `increase()` extrapolates over the selected interval. It is useful for activity trends but must not be presented as an exact integer event/cohort census. [Prometheus query functions](https://prometheus.io/docs/prometheus/latest/querying/functions/).

Illustrative PromQL, subject to the pinned OTLP naming/label contract:

```promql
# Activity trend: executed rejection percentage over Grafana's interval.
100 *
sum by (persona_family, reviewer_model_key) (
  increase(mission_persona_verdicts_total{verdict="fail"}[$__rate_interval])
)
/
sum by (persona_family, reviewer_model_key) (
  increase(mission_persona_verdicts_total{verdict=~"pass|fail"}[$__rate_interval])
)

# Exact current matured-cohort snapshot for this window, not an action count.
100 * sum(mission_analytics_runs_with_recovery{window="7d", horizon="7d"})
    / sum(mission_analytics_runs_eligible{window="7d", horizon="7d"})
```

Implementation supplies consistent audience/environment/installation filters, matching freshness/coverage checks and explicit zero-denominator behavior. A complete zero-failure slice needs a real zero series or a correctly aligned denominator-based zero fallback; do not convert absent telemetry into a zero rejection rate. The names above are proposed, not evidence of instruments already emitted or tested PromQL.

## SQL oracle for fixture semantics

The following SQL describes synthetic analytical views for a backend-independent test oracle. P5 translates these semantics into the bounded projectors and real PromQL panels above. Grafana's delivered dashboards do not depend on running this SQL or installing a warehouse. These are not tables currently in Mission Control.

```sql
SELECT persona_family, reviewer_model_key,
       COUNT(*) AS executed_reviews,
       SUM(CASE WHEN review_verdict = 'fail' THEN 1 ELSE 0 END) AS rejects,
       1.0 * SUM(CASE WHEN review_verdict = 'fail' THEN 1 ELSE 0 END)
         / NULLIF(COUNT(*), 0) AS rejection_rate
FROM review_facts
WHERE execution_disposition = 'executed'
  AND review_verdict IN ('pass', 'fail')
  AND occurred_at >= :window_start AND occurred_at < :window_end
GROUP BY persona_family, reviewer_model_key;
```

`review_facts` contains one row per eligible semantic review identity after ingestion deduplication. Raw model response records must not be loaded into this view as extra reviews.

```sql
WITH cohort AS (
  SELECT run_id FROM workflow_run_facts
  WHERE started_at >= :cohort_start AND started_at < :cohort_end
    AND observation_scope = 'complete_from_start'
), recovered AS (
  SELECT DISTINCT run_id FROM intervention_facts
  WHERE actor_kind = 'human'
    AND actor_basis IN ('owner', 'app_context')
    AND intent = 'recovery' AND outcome = 'completed'
    AND occurred_at <= :as_of
)
SELECT COUNT(*) AS eligible_runs,
       SUM(CASE WHEN recovered.run_id IS NOT NULL THEN 1 ELSE 0 END)
         AS runs_with_confirmed_recovery
FROM cohort LEFT JOIN recovered USING (run_id);
```

Production queries must also constrain each action to occur after that run's start and within the chosen horizon, apply the destination/consent epoch, and publish unknown/declared-only actor counts beside the result. These short examples illustrate grain and dedupe, not every operational filter.

## Shared golden fixture

Extend P3's worked run with five synthetic runs. All six belong to one complete-from-start cohort, observed through a declared common horizon. R3 remains pending at that horizon. R6 has an ambiguous action actor, so its interaction coverage is incomplete even though its start is known.

| Run | Outcome at horizon | Executed reviews, pass/fail | Human involvement |
| --- | --- | --- | --- |
| R1: P3 repair example | Completed | 3, with 2 pass and 1 fail | One successful human recovery |
| R2 | Completed | 2 pass | None, adequate observation |
| R3 | Blocked/pending | 0 | No confirmed human action yet |
| R4 | Cancelled | 1 fail | One human termination |
| R5 | Completed | 1 pass | One intentionally required human approval |
| R6 | Completed | 1 pass | One action with unknown actor |

Expected results:

- Executed review count: 8. Passes: 6. Fails: 2. Rejection rate: 25%.
- R1 additionally has 1 invalid response, 1 reused pass and 1 delivered repair packet; none changes those executed-review totals.
- Completed runs: 4 of 6; pending: 1; cancelled: 1. These remain separate categories.
- Confirmed manual recovery incidence: 1 of 6, or 16.7%. R6 adds one ambiguous run, so this is not an assertion that all other runs avoided human recovery.
- Known human-free completions: R2 only. R6 is not promoted to human-free just because its actor is unknown.
- Excluding R5's authored human gate leaves 5 automation-eligible runs. Report the known human-free count against that denominator separately, with R6's uncertainty visible.
- Duplicate delivery of R1's telemetry to a backend must not double analytical facts after that backend's documented dedupe/projection layer. If the backend cannot ensure this, expose the limitation and keep canonical fixture reconciliation authoritative.

Also test mixed authoring models, next-turn pending effort, multiple PRs on one task, late merge after session end and pre-opt-in in-progress runs. Each fixture has expected source facts, canonical records, metrics and trace links. It is shared across components rather than re-created with subtly different totals in each test.

## Release and optimization comparisons

Use app version/release channel at event time; workflow immutable version and persona revision at execution time; author/reviewer model roles; task kind; automation/human-gate policy; and execution/observation coverage. Keep these as distinct axes so an app release is not credited for a changed workflow or easier task mix.

Prefer within-installation before/after comparisons where identity/consent continuity allows, alongside the overall cohort. Stratify by task kind and workflow family/version; show model-selection differences rather than controlling them away silently. Large installations can dominate event-weighted results, so provide installation-weighted summaries as a separate view.

Compare completion and repair quality together. A faster workflow that bypasses more reviews or produces fewer verified outcomes is not necessarily an improvement. Useful paired measures include elapsed time plus completion, tokens plus accepted outcomes, and recovery incidence plus required-human-gate rate.

Show sample sizes and uncertainty. Treat low-count slices as exploratory, not ranked winners. Opt-in users are a selected population; metric correlations do not prove an app or model change caused the result. A randomized experiment, if later wanted, needs a separate product decision and assignment/exposure contract. No experiment machinery is included here.

## Freshness, quality and exclusions

P1 preserves occurred/observed/export timestamps, so report export lag and late-arrival volume. A seven-day local backlog can make yesterday's totals grow for days. Use provisional windows and re-evaluate affected cohorts when accepted late facts arrive; never move those events to today's activity chart.

Quality measures include known model/effort share, actor provenance, explicit outcome coverage, PR visibility, inferred/unknown reason share, capture gaps, expired/dropped records, unsupported schemas and incomplete spans. Do not claim exact completeness when disk failure prevented a loss counter from being saved.

Keep dev/test/demo and synthetic connection-test signals out of product adoption. Stamp explicit environment/source markers before export and validate them in the backend projection. Sessions observed before consent or telemetry cutover are not first-ever use. Identity reset/reinstall can appear as a new installation epoch; report that scope.

Sampling policy travels with traces. Core domain metrics and the outcome facts used for these denominators are unsampled after accepted capture. A trace backend configured to sample downstream can still lose drill-down coverage, which must not silently change the metric population.

## Performance and compatibility gates

Proposed acceptance targets for the prototype, not measured results or production guarantees:

| Area | Measurement / candidate target |
| --- | --- |
| Capture latency | Compare identical scripted workload with collection off/on; candidate p95 additional owner-boundary cost below 2 ms |
| Event-loop health | Record p95/p99 delay and slow operations; no sustained export-drain stalls |
| Throughput | Synthetic 20 concurrent sessions, 10 core events/second sustained, 100/second burst; size from actual serialized fixtures |
| Memory | Candidate incremental steady-state ceiling 32 MiB for bounded capture/projection/export work |
| Storage | Account for all profile copies, indexes, inactive aggregates and SQLite/WAL overhead; prove logical cap and document physical envelope |
| Shutdown/restart | Candidate local shutdown budget 2 seconds; offline remote flush cannot block exit; accepted records survive restart |
| Export recovery | Bound catch-up rate and in-flight requests; verify a healthy destination is not starved by an unhealthy one |
| Cardinality | Force unknown/custom models and many workflows; verify explicit overflow, stable totals and agreed series ceilings |
| Compatibility | Verify real receiver/backend handling of cumulative resets, duplicate batches, old timestamps, historical resources, partial success and trace links |
| Local stack | Measure CPU/RAM/disk separately from the daemon's 32 MiB candidate budget; publish tested image versions, host architectures, startup time and storage dependencies |

Measure these on representative supported machines. If targets fail, revise batching/storage/limits explicitly; do not remove restart durability or silently sample the core denominators to claim success.

The selected backend must handle the declared offline window. Configure and test Prometheus retention/out-of-order acceptance and Tempo's corresponding old-span/search limits against P1's queue age. Tempo documents that its WAL time-range slack affects whether old traces can be found in a time-bounded search. [Tempo configuration](https://grafana.com/docs/tempo/latest/configuration/). Do not assume current defaults accommodate a seven-day laptop backlog, or pass the test merely because the receiver returned success.

## Dashboard acceptance scenarios

1. Start the isolated reference stack from an empty test volume. Grafana contains all six dashboards and both data sources without manual setup. Every required panel has a manifest entry and a tested query.
2. Replay the shared fixture through real application capture/export with fake agents. Query Prometheus and inspect Grafana: executed reviews total 8, fail reviews 2, exact fixture rejection rate 25%, and the matured-cohort recovery panel shows 1 of 6. Freeze the fixture clock so the runs fall in the declared cohort. Validate activity-trend interpolation separately rather than expecting `increase()` to be an exact census.
3. Change environment, persona/model and workflow filters. Assert the expected affected panels and labels. Zero, empty, incomplete and stale fixtures render distinct states; R6 cannot appear as known human-free.
4. Open a failing review/error trace from Grafana and assert its event-time model/effort, stage and safe error/reason fields. Historical searches still locate a replayed trace after an outage. A trace link is not accepted solely because its URL is well formed.
5. Stop the whole backend stack, perform operations, restart Mission Control, then restart the stack. Verify the saved backlog drains, original event-time context remains visible, and canonical counts are unchanged. Repeat by stopping only Prometheus or only Tempo; persistent Collector queues survive a Collector restart.
6. Replay an ambiguously acknowledged batch. Verify metrics and analytical snapshots do not double; test trace duplication/search behavior explicitly. Test maximum supported late age and one sample beyond it, showing a visible loss/error when rejected.
7. Restart Grafana/Prometheus/Tempo without resetting volumes. Stored data, dashboard UIDs and navigation persist. Confirm normal demo runs do not alter the real-data project or enable product sharing.
8. Record measured daemon and stack budgets, cardinality, query latency and recovery time. Deliver runnable assertions and browser evidence along with the guide; keep evidence artifacts out of commits.

Use focused projection/contract tests and the repository's Playwright `e2e/` harness for the new dashboard user flows. Fake all agent calls, use accessible selectors and follow the existing test-state isolation contract. A local-stack test prerequisite can be explicit; it must have a reproducible command and may not be silently skipped when claiming P5 is complete.

## Integration order and ownership

These are design-level delivery boundaries. The [seven-phase implementation index](../phased-plan.html) turns them into merge units and dependency-linked tasks:

| Boundary | Deliverable and completion gate | Shared ownership to coordinate |
| --- | --- | --- |
| D0. Contract and compatibility spike | Minimal local Grafana/Prometheus/Collector/Tempo stack, one provisioned walking-slice panel, golden fixture, public SDK adapter, late-data/queue/query proof and pinned component versions | P0/P1/P5 shared event schema, metric catalog, projector interface and window/retention budgets |
| D1. Durable/profile foundation | Disabled/local-only/two-profile state, bounded journal/projection/outbox, restart/replay, consent and status | DB migrations, configuration registry, routes, SSE |
| D2. Session and workflow core | P2 attribution, P3 verdict/repair/intervention semantics and source reconciliation | Registry, supervisor, dispatcher, workflow manager/store |
| D3. Action/error breadth | P4 primary-action manifest, error handling, settings and browser coverage | Browser API, action owners, MCP and automation context |
| D4. Dashboard implementation and rollout | Six provisioned dashboards, bounded analytical projectors, PromQL/rules, trace navigation, local stack package, end-to-end fixtures, measured budgets and setup guide | P5 owns these artifacts; P0-P4 owners review required contract/instrumentation changes |

Each boundary may require several small pull requests. Plan exact dependency edges after the shared contract and prototype pass. Do not start several independent migrations or route/schema edits in parallel; shared files have one integrator, and feature owners add instrumentation through its agreed interface.

Within P5, deliver the stack/provisioning skeleton in D0; develop dashboards and required projectors as D2/D3 signals become available; finish cross-dashboard checks and documentation in D4. Source semantics, consent and durability tests remain acceptance criteria of P0-P4 as well. P5 does not defer their validation until the final phase.

The product ingest endpoint needs separately scoped enrollment/authentication, quotas, retention/access rules and backend storage. It cannot rely on a secret in the desktop binary. Client development can proceed against a local fake endpoint; public product sharing cannot be enabled until the actual service contract is ready. No hosting or release configuration change is implied by this plan.

## Cross-area conflicts resolved

| Potential contradiction | Resolution |
| --- | --- |
| All session metadata on every metric would explode series | Full allowed context on traces/records; small specialized metric views |
| A valid fail review looks like a failed model call | Review verdict, response validity and execution disposition are separate axes |
| Restart-safe export appears to promise lossless business capture | Durable acceptance boundary is explicit; source recovery and pre-acceptance gaps are measured |
| All blocked time looks like human waiting | Consume the existing lifecycle decoder and distinguish agent, human, external and unknown waits |
| One local queue could silently mix export audiences | Separate policy/identity/aggregate/delivery epochs with a combined capacity budget |
| Task status failed after departure appears to prove bad work | Preserve task status and completion evidence separately; unknown completion stays unknown |
| Replaying after upgrade could look like new-release activity | Original resource/version/timestamps retained and tested |
| Trace sampling could skew persona acceptance rates | Unsampled core event projection owns those metrics and analytical denominators |
| Grafana panels describe cohorts that PromQL cannot derive from action counts | P5 implements bounded daemon cohort projectors and exports their summaries as OTel metrics |
| P1's seven-day payload retention is shorter than rolling cohort state needs | Bound and charge separate minimal projection retention, with explicit completeness on expiry |
| P5 looks like a report with no build output | Six dashboards, local stack, analytical code, queries and executable end-to-end tests are mandatory deliverables |
| Scheduled consumers could start before contracts or plan paths exist | Every phase waits for the planning PR and its direct implementation prerequisites to merge |

## Remaining implementation decisions

Grafana and Prometheus are selected for the local dashboard deliverable. The durable adapter/store mechanism, compatible component versions/topology, measured limits and final event/category/UI contract remain prototype/design gates. Tempo and the Collector are proposed supporting components. The separate product-ingest service contract remains outside this local deployment. None of these gates makes working dashboards optional.

Verified on 2026-09-13: the cited primary documentation supports Prometheus OTLP metrics, Grafana file provisioning, Tempo trace search and PromQL extrapolation behavior. Proposed stack topology, projector budgets and performance remain to be tested in D0; no successful prototype or running local backend is assumed by this revision. Relevant tests, typecheck/lint, runtime build/smoke and UI E2E remain implementation completion requirements under AGENTS.md.
