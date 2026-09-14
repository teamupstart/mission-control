# OpenTelemetry for product use and workflow efficiency

Status: approved direction with scheduled implementation planning. The six linked briefs define contracts, examples, ownership and verification gates. Revised 2026-09-13: the operator requested dependency-linked implementation tasks, including actual local Grafana/Prometheus dashboards. See the [seven-phase implementation index](phased-plan.html) for the execution sequence and scheduling record.

Repository baseline: `5b59bc7a`. Research date: 2026-09-12.

## The six detailed designs

Confirmed decisions: support user-owned telemetry and product analytics with separate opt-ins; require restart-safe local capture in the first usable release; make P5 deliver actual dashboards on a local Grafana/Prometheus installation; schedule the work through the phased-plan skill.

| Brief to open | What it settles | Concrete review material |
| --- | --- | --- |
| [P0. Data contract](p0-data-contract/plan.html) | Signal meaning, grain, identities, actor provenance and audience policies | Example event, metric views, cardinality arithmetic, versioning rules |
| [P1. Durable export](p1-durable-export/plan.html) | Durable acceptance, storage, projection, replay and independent destinations | Crash-boundary matrix, SDK resource constraint, capacity/acknowledgement contract |
| [P2. Session lifecycle](p2-session-lifecycle/plan.html) | Session/task/conversation identity, actual model/effort and outcomes | Pending-effort timeline, mixed-model attribution, unknown exits and late PR facts |
| [P3. Workflow insights](p3-workflow-insights/plan.html) | Stages, executed reviews, reasons, repair and human intervention | Reason taxonomy, timing boundaries, worked retry/reuse example |
| [P4. Interactions, errors and settings](p4-interactions-errors-settings/plan.html) | Primary-action coverage, actor context, error handling and user controls | Action inventory, profile states, offline/consent user flows and E2E scenarios |
| [P5. Local Grafana dashboards](p5-analysis-delivery/plan.html) | Build the local reference stack, six dashboards, analytical projections and end-to-end coverage | Provisioned dashboard contract, PromQL, trace navigation, golden fixture and acceptance scenarios |

Read P0 first; P1/P2/P3/P4 can then be reviewed by area, followed by P5's dashboard implementation scope. P0-P5 are design areas; the seven implementation phases are separate merge units. Each brief's recommended field names, limits and mechanism remain reviewable; confirmed product requirements are firm, and the compatibility phase resolves unproven mechanisms before dependent tasks are released.

The original exploration below remains context. For detailed semantics and acceptance cases, the linked area owner is the source within this draft package; conflicts must be resolved before implementation.

## Recommendation

Build one daemon-owned telemetry facility that records meaningful application outcomes, projects them into OpenTelemetry metrics and traces, and can retain a bounded backlog locally. Instrument the owners of state transitions, then add browser interaction signals where the daemon cannot see intent or friction.

Start with session outcomes and workflow repair loops. They directly answer whether changes make the app more useful and workflows more efficient. Treat offline delivery as its own early design exercise: adding an exporter is straightforward compared with preserving correct counts and attribution through restarts, retries, model changes, and long-running workflows.

Recommend an application-owned durable queue, with an optional external Collector. Restart-safe capture is required in v1. Confirm the mechanism with a small durability prototype before broad instrumentation; a failed prototype must lead to another durable mechanism, not an in-memory-only release.

P5 requires a runnable local Grafana/Prometheus setup and six provisioned dashboards. Its proposed supporting components are an OpenTelemetry Collector for routing and Tempo for trace storage/search. Phase 1 builds the stack for P1's early compatibility test; Phase 6 implements the bounded cohort projectors and Phase 7 delivers the six dashboards. These are concrete implementation outcomes. See [the revised P5 scope](p5-analysis-delivery/plan.html) for component sources and acceptance criteria.

Confirmed audience decision: support both user-owned backends and aggregate product analytics, with separate opt-ins. The operator selected this in Mission Control on 2026-09-12. Each destination has its own export policy, queue and identity; configuring a personal backend does not enable product sharing. This decision specifies the future feature, not permission to export present operator data.

## What success looks like

The first useful analysis should answer these questions, grouped by app version, task kind, workflow version, authoring model and effort, and reviewer model where applicable:

1. Which workflows and features do installations actually use, and which do they try once and stop using?
2. Which workflow stages consume execution time, human waiting time, repair time, tokens, and estimated cost?
3. Which personas request changes most often, for what categories of reasons, and how often does the next round resolve them?
4. How often does a workflow finish without a human intervention after it starts? Which interventions are required decisions versus recovery from a problem?
5. Which session outcomes lead to completed tasks and verified pull requests? Which end early, are explicitly killed, or have an unknown outcome?
6. Does an app, workflow, persona, or default-model update improve these outcomes for comparable work?

An installation is not necessarily a person. Until an explicit account identity exists and is approved for this use, report active installations and sessions rather than unique users. Offline telemetry also makes recent cohorts incomplete; every dashboard should show data freshness and coverage.

## What the repository already provides

These are verified source observations, not claims from a running telemetry system. The [implementation index](phased-plan.html#repository-findings-and-reconciliations) records current-baseline evidence and reconciliations. The local investigation report is excluded from publication.

| Existing seam | Useful facts | Planning consequence |
| --- | --- | --- |
| `src/server/routes.ts:3988`, `src/server/usage.ts`, `src/server/spend-ledger.ts` | Claude OTLP metrics arrive locally; other usage paths feed the usage ledger | Reuse authoritative usage and deduplication. This receiver is not a general outbound OTel integration. |
| `src/shared/types.ts:245` | Session metadata includes observed model ID, effort, source and observation time | Snapshot effective values and their provenance. A configured default is not proof of what ran. |
| `src/shared/types.ts:1844` | Task kinds are `ship`, `scout`, `plan`, `pipeline`, `chat` | Reuse the existing vocabulary. Keep task kind separate from runtime and session origin. |
| `src/shared/workflow.ts:4252` | Node attempts retain runner, model, state, verdict and timestamps | Export attempt outcomes without reconstructing them from dashboard text. Reviewer effort is not an explicit field on this interface today. |
| `src/server/workflows/engine.ts:1090` | Response-contract failures and accepted response shapes are distinct from pass/fail verdicts | A valid fail verdict means the reviewer rejected the work, not that its model call failed. |
| `src/shared/workflow-stages.ts:15` | Stages are projected from a graph | Reuse that projection and immutable graph version; do not persist a competing stage model. |
| `src/server/registry.ts`, `src/server/db.ts` | Registry owns eviction; work episodes and per-repository PR associations preserve provenance | Observe these owners; do not add another session teardown path or infer PR success from prose. |
| `src/server/workflows/store.ts` | Durable events include manual infrastructure retries and uncertain-delivery resolutions | Expand explicit actor/reason attribution at these seams. Existing event payloads are not a safe export allowlist. |

## Collection approaches

| Approach | Benefits and tradeoffs | Rough effort | Impact |
| --- | --- | --- | --- |
| A. Direct SDK export, optionally to a user-managed Collector | Smallest initial integration. In-memory-only export is rejected for v1 because it cannot satisfy the confirmed restart-safe capture requirement. | M for foundations; full action coverage still L | Useful comparison point; requires proven persistence to qualify. |
| B. Bundle and supervise a Collector with persistent queues | Uses a standard export component. Adds a binary, packaging, upgrades, process supervision and a second local service. Data can still be lost before reaching the Collector. | L, including desktop integration | Strong export ecosystem with an installation and lifecycle cost. |
| C. Daemon-owned journal and durable export queue; optional Collector | Fits existing local ownership and supports capture before an endpoint exists. Requires careful projection, bounded storage, replay and compatibility tests. | L, split into independent milestones | Best fit for ordinary desktop use and later product analytics. Recommended for prototyping. |

Effort is relative scope, not a delivery estimate. The broad coverage requested is larger than any one exporter choice.

The Collector supports persistent sending queues using `file_storage`, but retry limits and disk capacity still bound retention. A Collector running only remotely cannot cache events that never left an offline laptop. [OpenTelemetry Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/).

## Proposed signal catalog

“Primary action” means an intentional operation that changes work, configuration, or navigation to a meaningful feature. It does not mean every render, pointer movement, SSE frame, poll, or keystroke. Maintain one typed action registry with owner, trigger, dimensions, result vocabulary, privacy policy and test coverage.

Metric names below are proposals. Use counters for occurrences, histograms for durations and distributions, and observable gauges for current backlog/state. Instrument units explicitly, with seconds for durations, bytes for sizes, and a named currency plus cost basis for money.

| Area | Events and outcomes worth collecting | Example metrics | Useful trace context |
| --- | --- | --- | --- |
| Dispatch and backlog | Task creation; dispatch requested, admitted, ready, failed; queue wait; dependency block; automatic/manual dispatch | `mission.dispatch.count`, `.duration`, `mission.task.queue.wait.duration` | Source surface, task kind, runtime resolution and preparation/launch/readiness spans |
| Sessions | Created vs first discovered; resumed; turn started/completed/interrupted; model/effort changed; context reset; handoff; end observation | `mission.session.started`, `.ended`, `.duration`, `mission.turn.duration` | Launch snapshot, observed execution segments, lifecycle and task outcome separately |
| Workflow adoption | Bound/unbound, started, restarted, completed, failed, cancelled, orphaned | `mission.workflow.started`, `.finished`, `.duration`, `.active` | Workflow identity/version, trigger, completion policy, linked work episode |
| Stages and nodes | Eligible, queued, execution started, completed, skipped, disabled, retried | `mission.workflow.node.count`, `.queue.duration`, `.execution.duration`, `mission.workflow.stage.duration` | Stage occurrence, node kind, submission, repair round, actual runner/model |
| Persona quality | Executed pass/fail; invalid response; contract violation; pass reuse; bypass; finding categories | `mission.persona.verdicts`, `mission.persona.response.errors`, `mission.persona.findings` | Authoring model and reviewer model separately, finding basis, directive/version provenance |
| Workflow repair | Feedback prepared/delivered/uncertain; session pickup; repair completed; resubmission; unchanged refusal; budget exhausted | `mission.workflow.repairs`, `.repair.duration`, `.repair.rounds`, `.delivery.failures` | Causal attempt(s), delivery identity, repair round, reason and actor |
| Human involvement | Manual resume, retry, restart, override, bypass, disable persona, change directive, permission response, clarification, cancellation | `mission.workflow.interventions`, `.human.wait.duration` | Whether required, recovery, or optional steering; cause; time since workflow start |
| Session actions and shipping | Action requested/completed/blocked; PR observed, created, updated, merged, closed; CI/review repair | `mission.session_action.count`, `.duration`, `mission.pr.outcomes` | Verified per-repository PR association, action attempt, observed vs app-created provenance |
| Feature use | Meaningful entry and successful use of Files, Diff, Runs, Library, search, archives, schedules, queues, ensembles, pipelines, Foreman and integrations | `mission.feature.used`, `mission.action.count`, `.duration` | Stable feature/action IDs, UI/MCP/CLI origin, completed/cancelled/refused/failed |
| Automation | Foreman invited/withdrawn; automatic answer, completion claim, handoff, rejected stale claim; Inspector outcomes | `mission.automation.actions`, `.failures`, `.wait.duration` | Automation role and result, never count an automatic answer as a human intervention |
| Ensembles and pipelines | Strategy selected, candidates launched/settled, human decision wait, winner applied, handoff, external stage results | `mission.ensemble.runs`, `.candidate.count`, `.decision.wait.duration`, `mission.pipeline.stage.count` | Parent work episode, child identities, strategy/provider, authoritative stage reports only |
| Errors and reliability | Dispatch failure, provider timeout/rate limit/auth, workflow engine/check failure, route error, UI exception, disconnect, daemon recovery | `mission.errors`, `mission.operation.duration`, `mission.connection.recoveries` | Error category/code, component, retryability and handled/unhandled status |
| Resource efficiency | Input/output/reasoning/cache tokens, API-equivalent cost, context pressure, compactions, warm/cold worktree preparation | `mission.tokens`, `mission.cost`, `mission.context.utilization`, `mission.worktree.prepare.duration` | Usage origin and coverage, cost/pricing basis, work role |
| Telemetry health | Pending records/bytes, oldest pending age, successes, retries, drops, expired records, rejected payloads, disabled state | `mission.telemetry.pending`, `.pending.bytes`, `.oldest.age`, `.dropped`, `.export.failures` | Destination class, schema revision, bounded export error code |

Prioritize the session, workflow, persona, repair, intervention and error rows for v1. Keep the remaining action inventory in the coverage roadmap so “all primary actions” is a measurable commitment rather than an unbounded instruction.

Distinguish actor from entry surface: human, agent, Foreman, workflow, scheduler, recovery and unknown are actor categories; dashboard, MCP, CLI and external observation are surfaces. Derive provenance from validated ingress and causal owner context, not an arbitrary caller-supplied “human” flag. Direct terminal interaction and external changes may not have reliable actor attribution. Keep them unknown and report that coverage limit rather than claiming all post-start human involvement is observable.

## Session metadata and attribution

Capture a launch snapshot, then immutable execution segments when relevant metadata changes. Every session-linked event references the snapshot/segment effective when it occurred. Historical exports must never join against today's model default or today's workflow definition.

| Scope | Metadata | Rules |
| --- | --- | --- |
| Application resource | Service name/version, release channel, OS family/architecture, instrumentation schema revision, environment | Stamp at event time. Exclude hostnames, usernames and filesystem paths. Keep runtime writer identity distinct from optional product installation identity. |
| Session context | Opaque session instance ID, logical conversation and work-episode links, harness, terminal/SDK runtime, launch/discovery origin | Keep these identities distinct. Context clears and SDK-to-terminal handoffs do not preserve every identity. |
| Execution segment | Requested model/effort; effective model/effort; provider; native effort when allowed; source, observed time and confidence state | Unknown, unsupported, inherited and observed are different states. Record model changes rather than rewriting the session's past. |
| Terminal context | Multiplexer ID and emulator ID, if present; capability/availability state | Derive through existing registries. Never export pane IDs, tty, PID, tab titles or commands. SDK has no terminal, which is different from an unknown terminal. |
| Task context | Task kind, creation/dispatch source, automatic/manual, queue/schedule association, single/multiple repository count | No task title, goal, repository URL, branch name or prompt. Discovered personal sessions may have no task. |
| Workflow context | Binding identity, workflow family and immutable version, completion policy, trigger source, node/stage occurrence, submission/round/attempt | One session can have multiple workflow bindings/runs. Represent links rather than one mutable workflow string. |
| Reviewer context | Persona stable ID/origin/revision, node execution override, actual runner/model, effective effort if available | The reviewer can use a different model from the authoring session. Missing reviewer effort stays unknown until supported at the execution seam. |
| Outcome context | Session end reason, task disposition, workflow outcome, completion evidence, PR outcome and observation coverage | Completed, killed, abandoned and PR generated are separate facts, not one enum. |

Full session metadata belongs on trace spans or correlated structured records. Each metric gets a small explicit dimension allowlist. Do not attach session IDs, run IDs, task IDs, repository IDs, trace IDs, raw error messages, arbitrary persona names or model endpoint URLs as metric labels.

Use catalogued model IDs and builtin workflow/persona IDs for bounded metric slices. Custom entities use a bounded `custom` category for aggregate metrics; destination-scoped opaque identities can support trace analysis. Offer explicit local allowlisting for more detailed user-backend dimensions later. Exact versions/revisions belong on traces by default, with selected bounded release/workflow version slices promoted only after a series budget is measured.

Keep process/stream resource identity where needed to prevent multiple metric writers colliding, and aggregate installations at the backend. OpenTelemetry's metric model requires a single logical writer per stream and makes reset/temporality handling explicit. [Metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/).

## Persona verdicts, reasons and repair loops

Keep four different outcomes:

1. **Review verdict:** an executed persona judged the work `pass` or `fail`.
2. **Response validity:** the model returned a parseable, contract-compliant review, or did not.
3. **Execution disposition:** actually executed, reused an earlier pass, disabled/bypassed, cancelled or infrastructure failure.
4. **Delivery disposition:** requested changes reached the session, failed delivery, or delivery is uncertain.

Reuse and bypass do not increase executed acceptance counts. An infrastructure failure does not become a work rejection. A persona may generate several findings, and several personas may contribute to one repair packet; retain all causal links while counting each verdict, finding and delivered packet at its own grain.

Use the existing finding bases (`substantive`, `coverage_registration`, `evidence_access`) as one axis. Propose a separate bounded general-reason axis: requirement mismatch, correctness, test coverage, missing execution evidence, missing visual evidence, maintainability, architecture, security, performance, documentation, delivery/PR, and other/unknown. These are proposed categories, not an inference that current verdicts already contain them.

Prefer existing structured facts and explicit persona output over text classification. Adding a category to persona results requires a versioned schema and backward-compatible unknown values. A local deterministic classifier is a possible transitional aid, but must export its version and `inferred` provenance. Do not introduce another paid model call per rejection. Do not export free-text requested changes, quotes, filenames or rationale by default.

Suggested derived measures:

| Insight | Definition |
| --- | --- |
| Executed rejection rate | Executed fail verdicts / executed pass-or-fail verdicts, grouped by persona and comparable workflow stage |
| First-review pass rate | Executed passes on a node's first semantic review / eligible first semantic reviews; infrastructure retries do not create new first reviews |
| Repair-loop burden | Repair rounds and repair time per finished run, with pending/cancelled runs shown separately |
| Next-round resolution | Failed nodes that pass on the next executed review / failed nodes with a next executed review; also show those never re-reviewed |
| Manual recovery incidence | Distinct runs with at least one human recovery action after start / eligible started runs in a matured cohort |
| Human-free completion | Completed runs with zero human interactions after start / eligible started runs; separately show workflows designed to require human gates |
| Intervention load | Successful recovery/steering/required-decision actions per run, not merely button clicks; display unsuccessful attempts as separate friction |
| Reason distribution | Findings per category, plus affected verdicts/runs; show unknown/inferred shares and multiple reasons per verdict |

Repeated-reason counts are not proof of repeated identical defects. Stable finding tracking would need a separate design and evaluation. Bypassing a persona is a frustration signal, not proof the persona was wrong.

## Endings, completion and PRs

Observe durable removal through Registry's existing lifecycle and pair it with explicit termination intent from the action owner. Keep `completed`, `operator_killed`, `cancelled`, `process_exit`, `lost`, `suspended_for_restart`, `handoff` and `unknown` distinguishable where evidence supports them. Final enum design must follow current lifecycle contracts rather than replacing them.

“Exited early” should mean a known session ended while its associated work was still incomplete at that time. “Abandoned” is a derived, configurable cohort classification after a grace period with no continuation, completion or handoff; it is not a raw event and must not be inferred from closing a window, a temporary discovery miss, or a missing PR.

Preserve task completion provenance: explicit completion, verified workflow completion, merged PR, cancellation, failure or unknown. Chat, scout and plan tasks may complete successfully without any PR. For PR-eligible work, distinguish no PR observed, existing PR associated, PR creation verified, merged and closed without merge. An unverified “PR created” message is an action attempt, not success. Keep late PR/merge observations as subsequent facts, including after the original session ends.

For multi-repository work, count the task once and each associated PR once at repository grain. Record creation coverage so “not observed” does not silently become “did not happen.”

## Traces and error signals

Use bounded operational traces: dispatch, a work turn, a workflow submission/review round, a session action and a recovery operation. Within a round, stage spans contain parallel node spans, which contain actual model/check calls. Link later repair/resume traces to their causal attempt and stable workflow/work-episode identity. An ensemble join can link several contributing traces.

Persist correlation and start-time facts, not live SDK Span objects. Emit completed spans as operations finish. Long human waits can be reconstructed from durable state intervals with their original timestamps; interrupted/unknown intervals must be identified. Do not hold one open span in RAM for a session lasting days or depend on a tail sampler holding an entire multi-day workflow. Verify historical span ingestion limits in the selected backend.

Derive product metrics from unsampled canonical domain records, independently of trace sampling. Start with complete coverage of the bounded core outcome/attempt spans; make high-volume UI and diagnostic tracing separately configurable and record any sampling policy. Trace-derived counts cannot substitute for unsampled acceptance and intervention denominators. If later sampling is needed, decide at bounded trace boundaries and retain independent error/outcome records; head sampling cannot guarantee that every later failure retains its original trace.

Stage wall time is elapsed time across parallel work, not the sum of persona durations. Keep queue delay, execution, repair activity and human wait separate, and distinguish elapsed time from CPU time or human effort. Record interruption and sleep/clock uncertainty instead of manufacturing precise execution time across a restart.

Attach expected domain outcomes such as a review fail to span attributes/events. Mark an operation as an error when the operation itself failed, not merely because a reviewer found an issue. Export bounded error counters and error spans/events with component, category, stable code, operation, retryability, handled state and sanitized fingerprint. Correlate renderer exceptions with the action when possible; disconnected/crashed processes may only support an uncorrelated error record on recovery.

OTLP logs are a useful extension for standalone errors and structured events. Keep them behind the same facade so SDK churn is isolated: OpenTelemetry JavaScript currently lists traces and metrics as stable, logs as development, and browser client instrumentation as experimental. This supports starting with typed browser events sent to the daemon rather than broad browser auto-instrumentation. [JavaScript status](https://opentelemetry.io/docs/languages/js/).

Use standard OTel resource, HTTP and exception conventions where appropriate and versioned `mission.*` attributes for app semantics. Evaluate current GenAI conventions for actual model calls during the execution-attribution design; do not make changing experimental conventions the application domain contract.

## Data flow and offline behavior

Proposed flow: browser, MCP and worker intents reach the existing daemon APIs. State-owning managers record authoritative results. A typed telemetry facade validates, minimizes and enriches selected records before a bounded local journal. A projection creates metrics and trace export batches. A durable outbox retries those batches to the chosen OTLP endpoint, directly or through an optional Collector. Export status returns to the dashboard through existing authenticated API and SSE patterns.

```text
Browser / MCP / workers -> existing daemon APIs -> state owners
                                                    |
                                      typed, minimized telemetry
                                                    |
                                      bounded local journal
                                                    |
                              metric + trace projection / checkpoints
                                                    |
                                      durable per-destination outbox
                                                    |
                                   OTLP endpoint or optional Collector

Outbox status -> daemon API / SSE -> Settings
Existing Claude OTLP cost ingest -> canonical usage ledger -> selected telemetry
```

Recommended contract for the durability prototype:

- **Explicit modes:** off, local capture only, and capture plus export. No endpoint is required for local capture. Local capture itself is a visible choice; enabling export later does not silently authorize historical sharing to a new audience.
- **Single owner:** the daemon owns journal/checkpoints/outbox writes. Foreman and MCP use HTTP. Use the existing database/migration owner; a dedicated telemetry database is an alternative only if measurement justifies it.
- **Projection, not replacement:** telemetry never becomes the source of truth for task or workflow behavior. Consume committed authoritative transitions. Where a durable source identity exists, use it for idempotency and crash recovery; close missing seams explicitly rather than periodically rescanning all history.
- **Failure boundary:** exporting is asynchronous and cannot block a session or workflow. Capture is bounded and must not turn an otherwise successful action into a failure. The prototype must prove the selected transaction/reconciliation approach and state its pre-journal crash-loss window. Do not promise atomic lossless capture and unconditional fail-open behavior without demonstrating both.
- **Replay:** give each record a version and stable event identity. Persist projection progress with resulting aggregate state and export batches atomically. Retry an immutable batch, not the original counter increments. Retain original event timestamps, resource version, metric start/end timestamps and trace IDs.
- **Temporality:** prefer persisted cumulative domain counters/histograms for the first compatibility spike, preserving stream start times; keep live process gauges separate. Test reset, old sample and out-of-order behavior in the actual backend. If delta is required, design and test interval identity, ordered delivery and duplicates explicitly. Replaying a queue must not double local aggregates.
- **Delivery guarantee:** bounded at-least-once attempts after durable acceptance, subject to expiry, capacity and permanent failure. An ambiguous remote acknowledgement can produce duplicates; generic OTLP backends do not promise exactly-once results. Maintain a local canonical count for reconciliation and test backend duplicate behavior. [OTLP specification](https://opentelemetry.io/docs/specs/otlp/).
- **Response handling:** obey signal-specific OTLP full-success, partial-success and retry rules. A partial-success response must not trigger replay of the entire request; record rejected counts. Separate retryable network/throttle errors from permanent payload/configuration errors, and prevent one poison batch from blocking all later data. [OTLP responses](https://opentelemetry.io/docs/specs/otlp/#otlphttp-response).
- **Bounds:** candidate payload retention is 7 days with a combined 256 MiB logical telemetry budget. Minimal P5 cohort state proposes a separate 30-day lifetime for its bounded lookback, charged to that same budget. These values are proposals, not measured capacity claims. Reduce optional high-volume interaction detail first; preserve a reserved budget for workflow outcomes/errors, but still enforce the absolute cap and expose incomplete cohorts and drops.
- **User control:** show pending count/size/age, last success, destination, last bounded failure, dropped/expired records, pause, retry and purge. Disabling collection must stop new capture and prevent unsent data from draining without explicit intent. Keep “pause export” distinct from disabling collection.
- **Destination changes:** queued data remains pinned to its original audience and endpoint generation. Changing an endpoint or opt-in requires an explicit keep-for-original, discard, or approve-backlog choice. Consent withdrawal purges unsent product data; it cannot retract data already accepted remotely.
- **Isolation:** keep credentials out of records, logs, exports and ordinary settings snapshots. Do not pass Mission Control's own outbound OTel environment to child agents or overwrite the existing Claude cost-ingest settings. Avoid forwarding data back to the local cost receiver or recursively instrumenting exporter failures.

Use official SDK/export/serialization components where their public interfaces fit. The persistence adapter and projection protocol need a compatibility spike; no hand-written OTLP implementation or package version is approved by this draft.

## Export audience and data minimization

Approved direction: both audiences, with independent opt-ins. Users may enable either, both or neither. User-owned operational export and minimized product analytics have separate schemas, queues and destination-scoped identities. Product analytics receives only its approved subset, not a copy of all user-backend telemetry. Failure or revocation of one destination must not block or redirect the other.

This choice rejects a user-backend-only scope because it would not directly supply the requested cross-installation product insights, and rejects product-only export because user-owned observability is also wanted.

Proposed common baseline: no prompts, transcript text, code, diffs, filenames, repository/PR URLs, branch names, feedback prose, terminal contents, authorization headers or environment dumps. Error messages/stacks can contain all of these; use bounded codes and sanitized app-frame fingerprints by default. A later diagnostic-detail mode requires a separate explicit contract.

Use random or keyed, destination-scoped opaque identifiers, with an identity reset option. Do not equate hashing a path or repository URL with anonymity. Custom workflow/persona names and custom model identifiers can also contain private information. Never copy raw workflow events wholesale into the export pipeline.

Keep collection consent and operational state out of automatically restored settings in ways that could silently enable sharing on another installation. A user-owned collector needs only its own endpoint credentials. A shared product ingest service cannot rely on a secret embedded in a distributed desktop app; authentication/enrollment, quotas, retention, abuse handling and remote data access need a separately scoped service design. P5 delivers local backend configuration; hosted product ingestion remains separate.

## Additional ideas worth tracking

- **Friction before success:** repeated failed action attempts, cancelled dispatch/forms, and time from feature entry to successful use. Compare an exposed feature with a used feature; a setting being enabled is not evidence it was used.
- **Time to first value:** first managed dispatch, first completed workflow and first verified PR after setup, with separate task-kind cohorts.
- **Automatic recovery effectiveness:** proportion of eligible stalls recovered automatically, time saved in waiting, and how often human intervention still follows.
- **Reviewer usefulness:** resolution on the next review, manual disable/directive rates and new findings after a prior pass. Avoid a leaderboard based only on rejection volume.
- **Model switching:** escalations after failures, reductions in effort after success, and per-segment repair burden. Distinguish author model switching from reviewer overrides.
- **Workflow structure:** node count, parallel width, custom versus builtin, required human gates, pass reuse and repair limits. These are potential explanations for performance differences.
- **Cost per useful outcome:** tokens and API-equivalent cost per completed workflow or verified PR, including repair and automation overhead, with unknown-usage coverage shown. Do not call these figures invoices or subscription spending.
- **Cross-surface continuity:** workflow started through MCP but recovered in the dashboard, session handed from SDK to terminal, or task continued by another session.
- **Reliability as experienced:** user-visible failure rate, blocked duration, reconnect recovery and successful resume after upgrade, rather than raw exception volume alone.
- **Observation quality:** proportion of sessions with observed model/effort, unresolved outcome, missing PR visibility, inferred reason, dropped telemetry and delayed export. Improving these may precede useful conclusions about users.

## How to turn data into decisions

Ship query definitions with instrumentation. A new counter without a decision it informs is lower priority.

| First dashboard | Decision it supports |
| --- | --- |
| Workflow funnel: started -> reviewed -> repaired -> completed -> PR outcome where applicable | Find where work stops, using distinct logical runs rather than attempt counts |
| Persona matrix: executed rejection rate, volume, reason, resolution, bypass/directive rate | Identify reviewers or instructions worth changing without rewarding permissive reviews |
| Model/effort cohorts: completion, repair rounds, waiting, tokens/cost | Evaluate defaults for comparable task kinds and workflow versions |
| Human involvement: required decisions vs recovery vs optional steering | Remove avoidable manual resumes without hiding deliberate control points |
| Release comparison: version, exposure, workflow revision, coverage and export lag | Detect regressions and assess improvements after updates |
| Feature adoption: exposure, first use, repeat use, successful use | Prioritize features users benefit from, not just frequently visible UI |

Keep denominator definitions, time windows, eligibility, unknown values and sample sizes beside the charts. Compare matured cohorts and show pending/cancelled/lost work rather than silently dropping it. Installation opt-in is a selection bias. Version correlation does not establish causality; use within-installation comparisons or a separately approved experiment for stronger conclusions. Do not claim a model is better because it was chosen for easier tasks.

OTel provides transport and signal semantics. The selected local dashboards run on Grafana/Prometheus, with Tempo proposed for trace drill-down. Phase 6 implements P5's bounded daemon cohort summaries where raw metric counters cannot answer a required question, so Phase 7's six dashboards do not depend on a future warehouse. Arbitrary retrospective joins remain outside this local reference scope.

## Six bounded planning sessions

Do not split by telemetry signal alone. Metrics and traces must agree on identity and semantics. Split by the questions and owners below, and share one approved data contract.

| Session | Scope and concrete output | Dependencies | Boundary |
| --- | --- | --- | --- |
| P0. Product questions and data contract | Audience/consent decision; prioritized action catalog; signal schemas; identity and cardinality budgets; completion/intervention definitions | This exploration | Locks what counts and what can leave a machine; does not choose database tables |
| P1. Durable export architecture | Compare app queue and Collector; prototype acceptance design; temporality/replay/ack protocol; retention, endpoint and shutdown behavior; package/backend compatibility ADR | P0 core contract | Owns transport/durability; does not add instrumentation across the app |
| P2. Session, task and execution attribution | Lifecycle mapping; requested vs effective model/effort; segments, handoffs, work episodes, PR provenance and late outcomes | P0 | Owns session context; does not reinterpret workflow engine states |
| P3. Workflow and persona insights | Stage mapping, attempts vs reviews, reason taxonomy, repair causality, actor provenance, wait intervals, example metric/trace fixtures | P0; coordinate identity with P2 | Owns workflow meaning; does not create a new stage or verdict authority |
| P4. Interaction, reliability and settings experience | Owner-by-owner primary-action inventory; browser-to-daemon signals; error schema; endpoint/status/consent controls; E2E scenarios | P0; coordinate endpoint states with P1 | Measures actual actions; no indiscriminate click capture |
| P5. Local Grafana dashboards | Specify a runnable local stack, six provisioned dashboards, required analytical projectors, PromQL/rules, trace navigation and end-to-end tests | P0/P1 for early stack proof; P2/P3/P4 for complete panels | Owns concrete dashboard/stack/code deliverables; source owners retain their own acceptance tests |

After P0, P1/P2/P3/P4 can be reasoned about concurrently as separate planning sessions using a frozen shared contract. P2 and P3 should exchange example records early. Keep `src/shared/types.ts`, `protocol.ts`, `db.ts`, `routes.ts`, Registry and workflow stores under coordinated ownership when implementation begins; parallel planning does not imply parallel edits to those files.

Suggested implementation sequence after those designs are approved:

1. **Walking slice:** one authoritative workflow attempt and one session context exported as a metric and trace, including disabled mode, offline backlog, restart and reconnect. Prove exact local counting, privacy and bounded failure behavior with fake endpoints and agents.
2. **Session and workflow core:** lifecycle, PR outcome, model/effort, persona verdict/reason and manual recovery coverage. Reconcile sample metrics against authoritative fixture rows.
3. **Primary-action and error coverage:** dashboard/MCP/automation origins, integration use, errors, settings and telemetry health, plus broader queues/ensembles/pipelines coverage.
4. **Dashboard implementation and rollout:** runnable local Grafana/Prometheus stack, six provisioned dashboards, bounded cohort projectors, tested queries and trace navigation, performance measurements and setup guide. Start the minimal stack in the walking slice. A hosted product ingest service has its own infrastructure scope.

Seven dependency-linked backlog tasks are now scheduled in the [implementation index](phased-plan.html) and [task map](schedule.html). Their dispatch waits for the planning PR and the direct phase prerequisites to merge; the compatibility phase resolves foundational contracts before its consumers are released.

## Verification bar for the eventual implementation

| Contract | Required evidence |
| --- | --- |
| Correct counting | Duplicate hooks/SSE/retries/restart produce one canonical event and one local metric contribution. Distinguish reused passes, invalid reviews, bypasses, cancelled attempts and actual work rejection. |
| Attribution | Mid-session model/effort change, unknown terminal metadata, separate reviewer model, task handoff, multiple workflows, and multi-repository PRs preserve event-time provenance. |
| Durability | Endpoint absent, offline/reconnect, crash at every projection/ack boundary, partial success, lost acknowledgement, throttle, bad credentials, poison payload, disk full, expiry and bounded drain. |
| Consent and minimization | Known private fixture strings never reach journal/export; disabling and purging stop queued delivery; endpoint changes and settings restore cannot silently redirect or enable sharing. |
| Lifecycle | Discovery miss, durable removal, restart suspension, real kill, task completion without PR, late PR merge and unknown terminal exit remain distinguishable. |
| UI behavior | Playwright specs exercise consent/configuration/status, intended actions and their resulting records using fake agents; verify modal inset for new modals. |
| Compatibility | Real local Collector/backend fixture receives intended metrics/traces, preserves exemplars/links when supported, and demonstrates duplicate/temporality/late-data behavior. |
| Performance | Measure enabled/disabled daemon latency, event-loop delay, queue growth, disk writes, exporter memory, shutdown time and high-cardinality stress against an agreed budget. |

Use repository typecheck/lint and focused tests for code changes; runtime changes also need build/smoke, and UI changes need the E2E coverage required by AGENTS.md. This planning-only task does not run the application suite or touch operator telemetry/state.

## Decisions and remaining uncertainty

Confirmed from the request and subsequent choices: comprehensive primary-action visibility; session/model/effort attribution; workflow/stage/persona and intervention analysis; errors; metrics and traces; restart-safe local capture in v1; and deeper designs across all six planning areas.

Approved product decisions: both user-owned export and product analytics with independent opt-ins; restart-safe capture required in v1; actual local Grafana/Prometheus dashboards as P5's deliverable. The operator specified the dashboard direction on 2026-09-13.

Remaining implementation decisions: the tested durable adapter/store mechanism; compatible local stack versions/topology and the separate product-ingest service contract; measured limits and the final event/category/UI contract. Grafana/Prometheus is selected. The [phased plan](phased-plan.html) schedules concrete implementation outcomes behind the planning PR and direct prerequisites; Phase 1 resolves the foundational compatibility gate. [P5](p5-analysis-delivery/plan.html) defines the dashboard deliverables.

Verified foundations: source-owned lifecycle and workflow seams, existing usage ingest, stage projection, observed session metadata, and current official OTel behavior cited above. Proposed architecture and defaults are recommendations, not verified existing behavior. The durable SDK adapter, capture transaction boundary, backend late-data behavior and performance envelope remain unverified until P1's prototype. Those are implementation gates; this draft does not build on an assumed successful prototype.

Design-package verdict: all six areas are developed and ready for review; prototype and implementation decisions remain pending.
