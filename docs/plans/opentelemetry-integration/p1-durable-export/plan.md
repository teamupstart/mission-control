# P1. Local durability and OpenTelemetry export

Draft architecture recommendation. Parent: [planning brief](../plan.html). Shared semantics: [P0 data contract](../p0-data-contract/plan.html).

Confirmed requirement: the operator selected “Require restart-safe capture” after reviewing the first-release tradeoff. Telemetry accepted into local storage must survive Mission Control restarts in v1, within documented retention and capacity bounds. The remaining choice is how to satisfy that requirement, not whether to defer it.

## Decision this area owns

Guarantee that telemetry already accepted into a bounded durable store survives a daemon restart, preserves original attribution and can be retried when a destination returns. Do not promise lossless capture before that acceptance boundary, unlimited retention or exactly-once delivery to an arbitrary backend.

Prefer one daemon-owned transport facility with independent destination profiles. A user-operated Collector is optional. A Collector bundled into the app remains the fallback if the public JavaScript integration surface makes application persistence disproportionately complex.

The operator selected a local Grafana/Prometheus dashboard deliverable in [P5](../p5-analysis-delivery/plan.html). P1's compatibility spike uses that reference stack early; P5 proposes a standalone Collector and Tempo for its metric/trace routing. This does not make the local stack a prerequisite for application capture or replace P1's restart-safe store.

## Architecture and ownership

Proposed flow:

```text
Authoritative domain owners / typed browser ingress
  -> validate, minimize, attach immutable context and collection policy
  -> bounded canonical journal
  -> per-audience projection and aggregate checkpoints
  -> immutable export batches and destination delivery state
  -> OTLP/HTTP endpoint, directly or through an optional Collector

Exporter status -> daemon API/SSE -> Settings
```

Only the daemon writes SQLite. Browser, MCP, Foreman and Electron report through daemon interfaces. The existing database setup uses a single synchronous connection with explicit transaction ownership. The workflow store's transaction helper opens `BEGIN IMMEDIATE`; it cannot safely receive a generic nested telemetry transaction. [Database ownership](../../../../src/server/db.ts), [workflow store](../../../../src/server/workflows/store.ts).

Reference storage proposal, not migration-ready SQL:

| Logical store | Key facts | Invariant |
| --- | --- | --- |
| Contexts/resources | Immutable allowed metadata, resource revision, policy epoch | No join to current defaults during replay |
| Journal | Sequence, event ID, schema, source identity, event/observation time, minimized payload, eligible profiles | Unique semantic identity; bounded bytes and age |
| Projection state | Catalog version, consumed sequence, active series, cumulative counters/buckets, source reconciliation cursors and bounded P5 cohort reducers | Aggregate contribution and checkpoint commit together |
| Export batches | Signal, destination generation, policy epoch, immutable payload/DTO, digest, original resource/timestamps | Retry does not reaggregate or restamp |
| Delivery state | Pending/leased/retry/accepted/rejected/expired, attempts, next retry, bounded error | Independent per destination; no unbounded retry history |

Use existing daemon DB/migrations initially only if measured storage and maintenance cost fit. A separate telemetry SQLite file is a possible daemon-owned alternative, not permission for another process to write. It provides a clearer physical quota boundary but loses same-database transactional opportunities. The prototype compares the tradeoff.

## Capture is a separate guarantee from export

Reference capture sequence:

1. The business operation completes at its existing authoritative owner.
2. A bounded telemetry append attempts to capture its normalized fact without network I/O. Success means journal commit; failure is contained and does not change the business result.
3. A bounded reconciliation adapter can recover facts from durable authoritative records where identity and event-time context are sufficient. Source retention and a cutover watermark bound that recovery.
4. Ephemeral UI intent/error observations that never reached durable acceptance may be lost. Expose capture coverage; do not synthesize missing history from mutable state.

This consciously leaves a crash window between a successful business commit and telemetry acceptance. Closing it requires an owner-specific transactional capture record with a demonstrated failure policy. Do not attach arbitrary telemetry work to every business transaction and claim both losslessness and unconditional fail-open behavior.

Durable domain facts with stable source identity can be reconciled idempotently. They still cannot recover metadata that was never frozen. A post-restart scan of a current Session cannot reconstruct its previous model. Source adapters must state what they can recover, their maximum scan/work per tick, and what becomes unknown.

## Projection and replay protocol

Read a bounded journal batch. In one projection-owned transaction, compute declared metric contributions, update bounded aggregate state, create deterministic completed span descriptors, create export-ready batches and advance the consumed sequence. No network calls occur inside this transaction. Any serialization work moved outside the transaction must use a persisted pending descriptor so a crash cannot advance the checkpoint without retaining its output.

Delivery leases one batch per ordered signal/stream partition, sends it asynchronously, then records its result. A crash before local acknowledgement retries the same immutable record. Lease recovery cannot assume a pending request was never accepted remotely.

Do not replay journal events through live SDK counters on every restart. The journal is processed once into durable aggregate state; retries operate on resulting batches. Reconciliation uses source event identity rather than re-counting all terminal rows at every startup.

Retain dedupe identities/cursors for the supported replay window even after export payloads are pruned. A committed capture cutoff prevents an expired historical source from being imported again as fresh activity. Late genuine observations, such as a merge recorded today for an old task, have their own semantic identity and observation time. The implementation must specify this horizon; a unique key on a journal row that is later deleted is not by itself durable deduplication.

Each destination gets its own aggregation and consent epoch. A product opt-in cannot receive the user's cumulative pre-opt-in total merely because both use the same local source. Eligibility considers original occurrence/capture policy and historical-import rules. A newly enabled profile starts a new metric stream baseline; runs already in progress are marked as pre-existing observations for cohort analysis.

## Metrics and traces have different persistence needs

For domain counts and explicit-bucket duration histograms, prototype persisted cumulative values with original stream start time. For live process gauges and optional diagnostics, use ordinary SDK collection with explicit best-effort coverage. Keep namespaces/projections disjoint so the same event is not counted by both.

Each queued metric point retains resource attributes, schema/catalog revision, temporality, start/end times, dimensions and values. Replaying after an upgrade cannot replace `service.version` with the new binary's version. Resource identity must distinguish logical writers, while a durable domain stream can survive a process restart when its state and start time actually survive.

For traces, persist operation IDs, correlation, original start/end timestamps and bounded attributes/events. A completed operation can be serialized later without keeping an SDK Span alive. Interrupted operations produce an explicitly incomplete/interrupted result on reconciliation when the owner can establish it, not an invented successful completion.

Important SDK constraint found during planning: the current JavaScript `MetricReaderOptions.metricProducers` option is experimental, and its documentation says additional producers' resources are replaced by the reader's SDK resource. A naive producer attached to the new daemon would therefore misattribute historical batches. The public exports include metric data types, a reader and producer interface, but this does not prove a compatible durable adapter for a selected package release. [MetricReader source](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/packages/sdk-metrics/src/export/MetricReader.ts), [public exports](https://raw.githubusercontent.com/open-telemetry/opentelemetry-js/main/packages/sdk-metrics/src/index.ts).

The prototype must select and pin a supported SDK/export/serialization path that preserves resources and IDs. Options are resource-partitioned readers with tested public extension interfaces, or another supported exporter/serialization boundary. Do not deep-import SDK internals, manually implement OTLP protobuf, or assume ordinary exporter callbacks expose sufficient partial-success detail. If no maintainable adapter passes, re-evaluate a local Collector before broad instrumentation.

## Transport contract

Recommend OTLP/HTTP protobuf as the first wire format, with explicit per-signal URLs or one base URL resolved once. JSON support and gRPC are later compatibility choices, not prerequisites. The existing local Claude receiver uses its own HTTP/JSON contract and stays independent.

Credential-bearing exports to non-loopback destinations require HTTPS. Loopback HTTP Collectors remain supported. Enforce this at configuration validation and the exporter boundary, and never forward credentials when a redirect changes the destination. TLS certificate verification stays enabled; remote credential-free endpoints still prefer HTTPS.

| Result | Delivery action |
| --- | --- |
| Valid full success | Mark accepted and release retained payload when no other local policy needs it |
| Partial success | Record accepted/rejected accounting from the response; do not retry the whole batch |
| Network failure, ambiguous disconnect or protocol-defined retryable response | Retry same batch with bounded backoff/jitter and valid Retry-After handling |
| Authentication/configuration error | Pause that destination visibly; do not hammer it indefinitely |
| Permanent payload/schema rejection | Quarantine bounded metadata or discard according to policy; continue unrelated valid batches |
| Oversized request | Prefer preventing it with the configured byte limit; any split/rebuild policy must be protocol-tested rather than assumed |
| Unexpected response or parse error | Preserve bounded diagnostics; follow the selected transport's tested failure classification |

OTLP defines retryability, partial success and ambiguous-acknowledgement limitations. Endpoint acceptance is not proof that a downstream dashboard indexed the data. Document each hop's durability promise. [OTLP specification](https://opentelemetry.io/docs/specs/otlp/).

Candidate transport budgets for measurement: 30-second collection/export cadence, 1 MiB maximum request payload, 10-second request timeout, one in-flight request per destination/signal, and jittered retry from roughly 1 to 60 seconds subject to server backoff and retention. These values are proposals. Recovery drains under a byte/rate budget so an overnight backlog cannot saturate the daemon or endpoint.

## Capacity, retention and scheduling

Candidate policy: seven-day age limit for retained journal/export payloads and a 256 MiB logical telemetry budget across contexts, journal, aggregates and both destination queues. The applicable age or capacity limit wins. Charge payload copies and pending serialization descriptors, not just journal JSON. Bound active series, orphaned contexts, leases and diagnostic histories too.

Minimal aggregate/dedupe state has its own declared lifetime. P5's seven-day start window plus seven-day outcome horizon needs a longer lookback than an unsent-payload queue; it proposes 30 days for bounded analytical reducer state, including late-arrival reconciliation. Charge that state to the same total budget, enforce consent deletion and expose incomplete cohorts if required state expires or is dropped. Finalize these lifetime pairs together in the compatibility spike; do not extend raw payload retention implicitly or retain aggregates indefinitely.

A logical quota in shared `harness.db` is not a hard cap on the SQLite file/WAL on disk. Deletes free pages for reuse but may not reduce file size. Measure physical overhead and maintenance effects; use a separate daemon-owned store if an independently enforceable disk budget is required. Never run disruptive whole-database compaction merely to shrink telemetry while sessions are active.

Admission order under pressure: stop optional diagnostic detail, then drop new low-priority interaction observations, while preserving a bounded reserve for outcome/error facts. At the absolute cap, even high-priority capture may fail and must not block work. Export lag, rejected/expired counts and capture gaps remain visible. If disk failure prevents recording a drop count, report an unknown gap on recovery instead of claiming a precise count.

Keep a stopped destination from exhausting the other's whole capacity by assigning per-profile shares with a total cap. An idle profile can lend capacity, but records never cross audiences. Prune unreferenced contexts and inactive series with explicit reset semantics. Do not preserve aggregates forever after their consent/retention context expires.

Export original historical points in stream order. Expiring older cumulative snapshots may preserve aggregate totals while losing temporal resolution; do not regenerate them with current timestamps or call a reconnect burst new activity. P5's freshness/coverage markers must expose such gaps. Backend rejection of old samples is visible loss, not grounds to silently retimestamp them.

## Consent, endpoint changes and shutdown

Collection modes are off, local-only and export-enabled profiles. Product and user-backend permissions are independent. Pausing export keeps bounded capture running; disabling a profile prevents new profile capture and drains no backlog. Withdrawing product consent purges unsent product batches/projections, while leaving separately authorized local/user data intact.

Each endpoint change creates a destination generation. Old batches never silently move to a new endpoint. The user may keep them for the previous endpoint, discard them, or explicitly approve a compatible transfer. Narrowing a policy can purge/reproject only from already allowed retained facts; it cannot widen sharing retroactively.

On shutdown, stop new export work, complete a bounded local commit and release/expire leases cleanly. A network flush is opportunistic and time-bounded; offline exit never waits for the remote server. On startup, recover leases, validate supported schema versions, reconcile bounded sources and start draining only enabled destinations.

Credentials are resolved at send time from a secret reference; they never enter journal or batch payloads. Do not mutate global `OTEL_*` variables that child agents inherit. No exporter traffic goes back into the existing local cost receiver, and exporter errors use a bounded self-diagnostic path to prevent recursive telemetry generation.

## Prototype acceptance matrix

| Injected boundary/failure | Required observation |
| --- | --- |
| Crash after journal commit, before projection | Event contributes once after restart |
| Crash during projection transaction | Checkpoint and aggregate/batch state either all commit or none do |
| Crash after remote acceptance, before local ack | Same payload/identity replayed; backend duplicate behavior documented |
| Upgrade with old batches pending | Old app version, policy, timestamps and schema retained |
| One destination offline, the other healthy | Healthy destination continues; budgets stay bounded |
| Consent withdrawal during in-flight send | Stop new sends and cancel when possible; acknowledge that already accepted data cannot be recalled |
| Long offline period, age/byte pressure | Defined admission/expiry, visible loss, bounded disk/memory |
| Partial success and invalid response | Correct status accounting without whole-batch amplification |
| Malformed/unknown schema record | Quarantine/expire bounded record, preserve other data |
| Source history pruned before reconciliation | Mark recovery gap; do not fabricate context |

Use only synthetic fixtures and local fake endpoints. Prove one review metric, one duration histogram, one trace and one standalone error, including privacy sentinel checks and both destination profiles. Testing must cover acknowledgement details as well as “HTTP request succeeded.”

## Rejected alternative and exit gate

An in-memory-only queue was considered and rejected for v1 because it loses accepted unsent data on restart. Best-effort capture can still describe the explicit pre-journal boundary and optional live diagnostics; it cannot describe accepted core telemetry or replace durable local capture.

Choose the durable implementation mechanism only after a public-API compatibility spike, backend replay test and measured storage/latency envelope pass. A failed application-queue spike requires another durable mechanism, such as a supervised persistent Collector with a demonstrated application-to-Collector acceptance boundary; it does not silently reduce the v1 requirement. This area is a concrete protocol proposal with named failure boundaries, not evidence that an SDK already provides those guarantees.
