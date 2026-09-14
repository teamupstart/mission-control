# Observability and telemetry

Mission Control can capture what it does as OpenTelemetry signals, keep them on disk until a
backend is reachable, and export them over OTLP/HTTP. This page covers what it collects, how to
turn it on, the local Grafana stack that ships with the repository, and the measured costs.

**Everything here is off by default.** An upgraded installation gains some empty tables, records
nothing, mints no identity and contacts nothing until an operator says otherwise.

This is the OUTBOUND facility. It is unrelated to the inbound `/v1/metrics` receiver that ingests
Claude Code's own cost metrics - see [Configuration](configuration.md) for that one. The two share
no storage, no configuration and no queue, and Mission Control refuses an export endpoint that
points back at its own address.

## What state it is in

Phase 1 of the [OpenTelemetry plan](plans/opentelemetry-integration/plan.md) is implemented: the
durable path, the export protocol, the consent model, the local reference stack and one working
diagnostic dashboard. Two events are captured today - the daemon's own start and the synthetic
connection probe. Session, workflow, action and error coverage arrive in later phases through the
registration seams described below.

## Turning it on

Collection and export are separate decisions, and so are the two audiences.

| Mode | What it means |
| --- | --- |
| Off | The default. No journal row is written. |
| Local only | Collection on with no endpoint. Facts are captured, projected into local aggregates, retained and visible through the health API. Nothing leaves the machine. |
| Your own backend | Local only, plus export to an OTLP/HTTP endpoint you choose. |
| Product analytics | Reported as `unavailable` and refused. There is no public ingest service in any shipped build, and offering the switch anyway would queue data for an address that cannot exist. |

Phase 2 adds the Settings panel. Until then the loopback API is the control surface:

```sh
# Local-only collection.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' -d '{"enabled":true}'

# Local collection plus export to the local reference stack.
curl -X PUT localhost:7317/api/telemetry/config \
  -H 'content-type: application/json' \
  -d '{"enabled":true,"user":{"enabled":true,"endpoint":"http://127.0.0.1:14318"}}'

curl localhost:7317/api/telemetry/health          # queue depth, bytes, gaps, pause reasons
curl -X POST localhost:7317/api/telemetry/probe -d '{"profile":"user"}' \
  -H 'content-type: application/json'             # a real OTLP request, plus a captured fact
curl -X POST localhost:7317/api/telemetry/drain   # run one cycle now instead of waiting 30s
```

Disabling is not pausing. Pausing stops sending and keeps the backlog; disabling stops capture and
purges that profile's unsent batches and projections. Withdrawing consent cannot recall data a
backend already accepted, and the app does not pretend otherwise.

### What travels, and what never does

Captured: app version, launch mode, bounded outcome enums, durations, and an installation
pseudonym. Every event is validated against a strict schema that rejects undeclared fields, so an
internal object cannot be spread into a record by accident.

Never captured: prompts, code, file paths, branches, repository or PR URLs, terminal output,
rationale text, headers or free-text error detail.

Every record carries a `deployment.environment.name` resource attribute, `local` by default and
overridable with `MISSION_TELEMETRY_ENVIRONMENT`. It exists so demo, development and test signals
can be kept out of adoption analysis rather than filtered out afterwards by guesswork.

The installation pseudonym is a local random seed. It supports repeat-use and within-installation
comparison, and nothing else - there is no account lookup, no cross-device join and no
fingerprinting. Resetting it starts a new installation epoch, which downstream legitimately reads
as a new installation.

Export credentials live in a daemon-owned table, never in the config blob. They are resolved at
send time and appear in no read path, no settings snapshot and no exported payload. Telemetry
configuration is deliberately excluded from settings snapshots altogether: consent is not a
portable setting, and restoring a snapshot from another machine must not be able to turn
collection on.

### Where a credential may travel

Enforced identically at configuration time and at the wire boundary, because a rule checked in
only one of those places is a rule an operator can save past:

- A credential-bearing export to a non-loopback endpoint requires HTTPS.
- A loopback HTTP Collector is supported, credential or not. Every local Collector is one.
- A remote plaintext endpoint with no credential is allowed and flagged.
- Credentials in the URL are refused; use the header field.
- A redirect that changes origin, or downgrades to remote plaintext, drops the credential.
- `OTEL_*` environment variables are never mutated, so no agent subprocess inherits an exporter
  endpoint or credential.

## The durable path

```text
owner completes its work
  -> capture(): validate, minimize, attach immutable context, commit a journal row   [accepted]
  -> projection: reduce a bounded slice into durable cumulative state + immutable batches
  -> delivery: lease one batch per destination and signal, send, record the result
  -> OTLP/HTTP endpoint
```

**Accepted means committed.** `capture()` returns `accepted` only after a journal row is durably
written, does no network I/O, and never throws: a source hook sees accepted, duplicate, disabled or
refused, and a telemetry failure never rewrites a successful business result.

**There is a pre-acceptance gap, and it is not closed.** A crash between a business commit and the
capture call loses that fact. Closing it would mean attaching telemetry work to every business
transaction, which the design rejects; the honest alternative is to measure the gap, which is what
the `capture_refused` and `unknown_gap` counters in the health view are for.

**The journal is processed once.** Cumulative totals live in a durable table keyed by profile,
consent epoch, resource and dimensions. Retries operate on immutable batches. Nothing replays
journal events through live counters, which is the failure that would double every metric on every
reboot.

**Deduplication outlives the payload.** Source identities live in their own table with a longer
window than the payloads, because a unique key on a row that later gets pruned is not durable
deduplication - the same expired historical source would be admitted again as fresh activity.

Crash boundaries covered by `test/telemetry-durability.test.ts` and
`test/telemetry-transport.test.ts`: crash after journal commit and before projection; crash inside
a projection pass; crash after remote acceptance and before local acknowledgement; upgrade with
batches still queued; one destination offline and the other healthy; consent withdrawal with work
in flight; a long offline period under age and byte pressure; partial success; a poison batch; an
unknown schema version; and a controlled shutdown.

### Extension seams

Later phases add coverage through two separate registries, and neither writes into the other's
tables:

- `registerTelemetrySource` - an owner that captures facts. It must declare what a restart can
  recover and what becomes permanently unknown; a post-restart scan of a current session cannot
  reconstruct the model it was running an hour ago, and saying so at the registration site is what
  keeps the next phase from assuming otherwise.
- `registerTelemetryProjection` - a bounded, versioned, checkpointed reducer over the journal, with
  its own namespaced state rows and its own state migration. Phase 6's analytical reducers register
  here; the `snapshot` hook is where cohort gauges are published.

A reducer is handed a `TelemetryEnvelope` - the semantic record - and never the stored journal row
the engine hydrated it from. A reducer that compiled against the stored row would have to be edited
whenever the journal's storage or hydration changed, despite having no opinion about either, and
nothing would stop it reading `seq`, `profiles` or `epochs`: engine bookkeeping that answers "which
pass, and under which consent epoch" rather than "what happened". The engine converts once, before
it calls anything registered here, and keeps that bookkeeping to itself.

Event and instrument definitions live in `src/shared/telemetry-catalog.ts`. Every feature group
across all six design areas is already declared there with its owning phase, so a later phase adds
entries to an existing group rather than coining a parallel taxonomy. Instruments declare an exact
dimension allowlist; unbounded identities and content-bearing keys are refused by a catalog test
rather than by review.

## The local reference stack

Four pinned containers, all published on loopback only. Optional, independent of the app's
lifecycle, and not part of the Electron package: Mission Control goes on capturing when the whole
stack is stopped.

```sh
npm run observability:up       # start, then wait until every component reports ready
npm run observability:status
npm run observability:verify   # validate compose + prometheus config/rules with the pinned tooling
npm run observability:down     # stop; data volumes survive
npm run observability:reset    # stop AND destroy every data volume
```

| Component | Version | Host address |
| --- | --- | --- |
| OpenTelemetry Collector (contrib) | `0.160.0` | `http://127.0.0.1:14318` (OTLP/HTTP) |
| Prometheus | `v3.14.0` | `http://127.0.0.1:19090` |
| Grafana Tempo | `2.10.8` | `http://127.0.0.1:13200` |
| Grafana | `12.4.10` | `http://127.0.0.1:13000` |

Point Mission Control at `http://127.0.0.1:14318` and open
`http://127.0.0.1:13000/d/mission-telemetry-diagnostics`. Both data sources and the dashboard are
provisioned from files; nothing is imported by hand, and dashboards are not editable in place so a
browser edit cannot silently diverge from the repository.

Container-to-container traffic uses service names (`http://collector:4318`); the host uses the
published ports above. Mixing the two up is the most common way this stack appears broken.

### Settings that are load-bearing

- **Prometheus OTLP receiver** is off by default and enabled with `--web.enable-otlp-receiver`.
  Without it `/api/v1/otlp/v1/metrics` returns 404, which the exporter reports as a configuration
  fault and which looks exactly like a wrong URL.
- **Metric name translation is pinned** to `UnderscoreEscapingWithSuffixes`, so
  `mission.daemon.starts` lands as `mission_daemon_starts_total`. `promMetricName` states the same
  mapping in code and a unit test asserts it, so a receiver default moving fails a test instead of
  emptying a panel.
- **`out_of_order_time_window: 8d`** is one day longer than the app's queue. Without it a laptop
  that was offline for a week drains successfully, gets 200s the whole way, and has every sample
  silently refused as too old.
- **The Collector's queues are persistent**, backed by a volume. A default in-memory queue would
  add a brand new loss window immediately downstream of a store that exists to have none.
- **Tempo's `max_duration` and `block_retention`** reach past the app's queue window, or a replayed
  old trace exists in storage and cannot be found by a time-bounded search.

### Verifying it end to end

```sh
npm run observability:up
npm run test:telemetry-stack        # queries the real Prometheus and Tempo, not just HTTP status

npm run build
MC_E2E_OBSERVABILITY=1 npm run test:e2e -- \
  e2e/specs/telemetry-diagnostics-dashboard.spec.ts --workers=1
```

Neither skips silently. The integration test fails with the command to start the stack; the browser
spec skips only when `MC_E2E_OBSERVABILITY` is unset and says so, because ordinary CI has no Docker.

## Measured costs

Measured on an Apple M-series laptop, Node.js 26, 5,000 synthetic events with collection on and one
export destination configured. These are this build's numbers, not a guarantee.

| Measure | Candidate target | Measured |
| --- | --- | --- |
| Capture p95, collection off | - | 0.007 ms |
| Capture p95, collection on | under 2 ms added | **0.65 ms** (0.64 ms added) |
| Capture p99, collection on | - | 0.85 ms |
| Projection cost | - | 0.14 ms per event |
| Logical bytes per event | - | **645 B** (journal + batches + aggregates + contexts) |
| Physical database growth per event | - | ~1.0 kB including WAL |
| Local stack, idle | - | ~290 MiB RSS total, ~1% CPU (Tempo 103, Grafana 101, Prometheus 51, Collector 36 MiB) |

At 645 B per event the 256 MiB logical budget holds roughly 400,000 events, which the seven-day age
limit will normally reach first.

### Retention and limits

| Limit | Value | Why |
| --- | --- | --- |
| Payload retention | 7 days | Bounds the bytes: journal facts and undelivered batches are the large objects. Settled delivery bookkeeping is swept on the same window, so the per-batch `accepted`, `rejected` and `expired` counts in the health view describe the retention window rather than the installation's whole history. |
| Reducer/dedupe state retention | 30 days | Bounds the identities. The rolling cohorts later phases need a 30-day lookback for, and an expired source must not be importable again as fresh activity. |
| Total logical budget | 256 MiB | Charged across contexts, journal, aggregates and both destination queues. |
| Series per instrument / per profile | 2,000 / 10,000 | Beyond it, dimension values fold into an explicit overflow bucket. The total stays correct; only the breakdown degrades, and a gap counter says so. |
| Event payload | 16 KiB | |
| Request payload | 1 MiB | Prevented at build time rather than split afterwards. |
| Collection and export cadence | 30 s | |
| Retry backoff | 1 s to 60 s, jittered, `Retry-After` honoured | |

A batch parked for a superseded endpoint keeps its payload so Phase 2 can offer the keep,
discard or transfer choice, and is released on the same seven-day window once that choice has
gone stale.

The stricter of age and capacity wins. Shedding under capacity pressure re-checks the budget
between every drop and stops as soon as it is back under the mark, so a brief overshoot costs
the oldest batch or two rather than the whole queue. Loss is always counted and visible in the
health view - and
where a failure prevented even the counter from being written, recovery reports an **unknown** gap
rather than claiming a precise number.

That invariant reaches exactly as far as the daemon can see, and where it ends is worth saying
plainly. A batch is accepted, and its copy released, the moment the Collector returns 200 - the
Collector owns it from there, and nothing it does afterwards can reach the health view. So the
reference stack is configured never to drop: both exporters retry with **no elapsed-time ceiling**
(`max_elapsed_time: 0`). A ceiling would expire queued items during a long Prometheus or Tempo
outage - a Docker Desktop restart, a sleeping host, a maintenance window - and that loss would
appear only in the Collector's own logs while the health view still read zero gaps. Retrying
indefinitely turns the same outage into backpressure instead: the persistent queue fills, enqueue
begins failing, the OTLP receiver answers the daemon with an error, and the daemon keeps its own
copy. Loss then happens only where it can be counted, against the daemon's own bounded retention.

A different backend, configured by an operator, keeps its own promises. The daemon's guarantee is
about what it accepted and has not yet handed over.

A logical quota inside `harness.db` is not a hard cap on the file or its WAL. Deletes free pages
for reuse without shrinking the file, and no whole-database compaction is ever run to reclaim
telemetry space while sessions are active.

## Decisions worth knowing

### Why the exporter does not use a MetricReader

The obvious integration - attaching a durable queue as a `metricProducers` entry on a
`MetricReader` - is wrong here, and quietly so. That option is experimental and its documented
behaviour is that the reader REPLACES an additional producer's resource with its own. A batch
queued before an upgrade and drained after one would therefore be exported stamped with the running
binary's `service.version`, moving yesterday's work into today's release cohort - the exact
misattribution the design forbids.

Instead the exporter uses `@opentelemetry/otlp-transformer`'s public `ProtobufMetricsSerializer`
and `ProtobufTraceSerializer`, which accept a `ResourceMetrics` and a `ReadableSpan[]`. A persisted
batch is rehydrated into those shapes with its OWN resource and its OWN timestamps. No SDK
internals are deep-imported and no OTLP protobuf is hand-written. The package versions are pinned
exactly, because this leans on the shape of two public interfaces and a caret range is how that
stops being true quietly.

`test/telemetry-contract.test.ts` asserts the resource and timestamps survive; the stack test
asserts a historical `service.version` arrives at Prometheus as its own stream.

### Why telemetry lives in `harness.db`

A separate telemetry file buys one thing - an independently enforceable disk quota - and costs
four: its own version, recovery, upgrade and backup lifecycle, its own ownership story, and the
property the whole design rests on, that a projection checkpoint, its aggregate state and its
output batch commit in ONE transaction with the writer that already serializes every other write in
the process.

The quota argument is also weaker than it looks, since a logical quota in a shared file is not a
hard cap on the file either way. The measured envelope above - 645 logical bytes per event against
a 256 MiB budget - is small enough that the budget plus the retention sweep bounds it adequately.
If a later phase needs a hard disk cap, the store interface is the seam to move; nothing above it
names a file.

### Why cumulative, and what a duplicate delivery does

The durable aggregate is cumulative with a preserved stream start time, so a restart continues the
stream rather than looking like a reset. It also makes the ambiguous-acknowledgement case - a crash
after the server accepted a request and before the local acknowledgement - idempotent by
construction: replaying the same immutable snapshot writes the same value. The stack test asserts
exactly that against a real Prometheus.

A changed app version is a different OTLP resource and therefore a different stream with its own
start time. A new line appearing on a chart at an upgrade is correct behaviour.

### What is not proven

- Only Prometheus and Tempo at the pinned versions above have been tested, on macOS on Apple
  silicon, with Docker. Other backends, other architectures and other versions are unverified.
- Metric exemplars are not claimed. The Grafana data source is provisioned for them so drill-down
  works the moment the exporter and receiver path is shown to carry them; today trace navigation
  goes through the Tempo search panel.
- The 30-day reducer window is enforced but has not been exercised over a real 30 days.
- Throughput was measured single-process and synthetically, not under a fleet of live sessions.

## Troubleshooting

**A panel says "no exports yet".** That is different from a zero. It means nothing matched the
query in the selected range - commonly because the installation filter is pinned to an installation
that has not exported that metric. `GET /api/telemetry/health` reports this installation's id, its
queue depth and any pause reason, which tells a stopped export apart from a quiet installation.

**Nothing arrives, and health shows a growing queue.** Check `pausedReason`. `auth` and
`configuration` mean the destination refused and the daemon stopped rather than hammering it; fix
the endpoint or credential and clear the pause by saving the configuration again. `quota` means it
throttled ten attempts in a row, with or without a `Retry-After` to say for how long; reduce what
is being exported or raise the backend's limit, then save the configuration again to resume. A
plain outage or server fault never pauses, so the backlog drains by itself when the link returns.

**A backlog drained but old samples are missing.** Prometheus refuses samples older than its
out-of-order window. Eight days is configured here; a sample older than that is real, visible loss
and is reported as such rather than retried forever.

**`docker compose` hangs with no output at all.** Docker Desktop's CLI hints and interactive
Compose menu make network calls before running the command, and a machine where those calls hang
produces exactly this. `npm run observability:up` already disables both; a raw `docker compose`
invocation may need `DOCKER_CLI_HINTS=false COMPOSE_MENU=false`.

**The Collector refuses to start over its queue directory.** That refusal is correct - it will not
fall back to an in-memory queue. The `queue-permissions` one-shot service in `compose.yaml` gives
the volume to the Collector's user; if you removed it, put it back.
