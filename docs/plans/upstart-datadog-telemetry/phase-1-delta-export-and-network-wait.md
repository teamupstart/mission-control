# Phase 1: Delta export and the network wait

Source plan: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome and value

An OTLP destination can be told to export **delta** metrics instead of cumulative ones, and
to treat a refusal from a Cloudflare edge as "off the network, keep waiting" rather than "the
credential is wrong, stop". Both are generic destination capabilities. Nothing turns them on
by default, and no Upstart code arrives in this phase.

This is what makes Upstart's telemetry gateway usable at all. It runs several Collector
replicas whose Datadog exporter converts cumulative sums to delta per replica, which inflates
counts when points of one series land on different replicas. Its Cloudflare edge also refuses
laptops off Upstart's network with a 403, and today that 403 pauses the destination until a
person saves the configuration again.

Engineering value:
- Datadog's agentless OTLP intake also accepts only delta, so this is useful beyond Upstart.
- Delivered points older than the backend accepts are now counted rather than lost silently.

## 2. Entry criteria and dependencies

- Direct phase dependencies: none.
- The source plan and this file are on the default branch, which is what releases this task.

## 3. Scope and non-goals

In scope:

- **Two destination fields**, with defaults that leave every existing installation byte-for-byte
  unchanged: `temporality` (`cumulative` | `delta`) and `networkGate` (`none` |
  `cloudflare-edge`).
- **A third destination field**, `lateAfterMs` (null or a positive integer), which makes points
  older than the backend accepts countable.
- **Delta batch building.** It uses a durable per-series watermark and never sends a zero
  delta. Gauges are sent on change, with an hourly heartbeat.
- **A `waiting` delivery outcome** for edge-served 403s on gated destinations. It has its own
  backoff ceiling, surfaces in health and in the settings summary, and is shown in Settings >
  Telemetry.
- **An editable "Metric temporality" control** on each remote destination in Settings >
  Telemetry, so a person can configure a Datadog-compatible destination by hand. This follows
  the 2026-09-29 decision that people on machines that are not Upstart-managed edit their
  telemetry settings.
- **Documentation** in `docs/observability.md`, including a revision of "Why cumulative, and what
  a duplicate delivery does" for delta destinations.

Non-goals:
- export shapes, label drops, histogram conversion, host attributes or budgets (Phase 2);
- anything Upstart-specific (Phase 3 onward);
- sending anything to the real gateway (Phase 6's pilot);
- UI controls for `networkGate` and `lateAfterMs`. They are set through
  `PUT /api/telemetry/config`, and the Upstart preset sets them in Phase 3.

## 4. Repository findings and inherited contracts

Findings this phase relies on. Line numbers were taken on 2026-09-28 and will drift.

**Destination config.**
- `TelemetryDestinationSchema` is at `src/shared/telemetry.ts:318-326`. It is not `.strict()`,
  and the stored blob is parsed with defaults (`src/server/telemetry/config.ts:101-103`), so a
  new defaulted field is upgrade-safe with no migration.
- `GET /api/telemetry/config` is pinned byte-for-byte in `test/fixtures/route-surface.json`, and
  adding fields changes that fixture.

**Projection.**
- `runProjectionPass` (`src/server/telemetry/projection.ts:251-265`) already holds `config`.
  `runOne` (267-360) folds, writes batches and checkpoints inside one `telemetryTransaction`.
- A batch contains only the series touched in that pass, each carrying its full cumulative
  value (`Collector.apply`, 481-589).
- **Passes with no events.** A pass with no new journal events returns early, before
  `Collector.apply`, unless the projection sets `idleSnapshots` (`projection.ts:306-319`). Only
  the analytical projection sets it. Without a change here, an untouched gauge would never
  heartbeat.
- **Health gauges.** Every 30-second cycle, `captureTelemetryHealth` emits one
  `mission.telemetry.health` event per capturing profile (`service.ts:93`, `health.ts:42-55`),
  which feeds the nine `mission.telemetry.health.*` gauges through `CATALOG_PROJECTION`. So those
  gauges are touched every cycle while collection runs, and `observed_at` changes every cycle.
- `startTime` is set once when a series is created, and `lastTime` is the maximum event time
  seen.

**Series and generation.**
- The series key is `(profile, policy_epoch, resource_id, instrument, dimensions_key)`
  (`src/server/telemetry/schema.ts:132-152`). There is exactly one destination per profile, so a
  column on a series row is a per-destination value.
- An endpoint change bumps `telemetry_destinations.generation` (`config.ts:417-426`). Queued
  batches from the old generation are fenced at lease time and retained for 7 days
  (`delivery.ts:150-172`).
- `migrateTelemetry` is empty today (`schema.ts:287-289`), and `addTelemetryColumn` is the
  idempotent helper for new columns.

**Serialization and delivery.**
- `src/server/telemetry/otlp.ts` hard-codes `AggregationTemporality.CUMULATIVE` for histograms
  (78), gauges (100) and sums (108). `test/telemetry-contract.test.ts:177` pins it.
- `classify` (`delivery.ts:396-444`) maps 401 and 403 to `paused/auth`. Any non-null
  `pausedReason` stops delivery for the profile (`delivery.ts:106`).
- The backoff ceiling `retryMaxMs` is 60 seconds, shared, clamps `Retry-After`, and is pinned by
  `test/telemetry-transport.test.ts:573`.

**Health and settings status.**
- Health and summary shapes are `TelemetryProfileHealth` and `TelemetryProfileSummary` in
  `src/shared/telemetry.ts` (around 420-443 and 589-601).
- Every summary leaf must be compared in `Registry.emitSettingsStatus` / `sameTelemetrySummary`
  (`src/server/registry.ts:708-746`). `test/settings-status.test.ts` enumerates the leaves and
  fails on a new one it has no case for.

**Datadog behaviour (measured or documented 2026-09-25 to 2026-09-28).**
- A delta sum arrives as a Datadog count with the exact value; the plan's validation section
  records the synthetic `mission.daemon.starts` point.
- Datadog drops metric points more than one hour older than their submission time, unless
  Historical Metrics Ingestion is turned on for that metric.

Inherited contracts: none.

## 5. Implementation steps, in order

1. **Shared schema (`src/shared/telemetry.ts`).**
   - Add to `TelemetryDestinationSchema`:
     - `temporality: z.enum(["cumulative", "delta"]).default("cumulative")`;
     - `networkGate: z.enum(["none", "cloudflare-edge"]).default("none")`;
     - `lateAfterMs: z.number().int().positive().nullable().default(null)`.
   - The patch schema's `partial()` picks them up. Document each field in the style of its
     neighbours.
   - Add `TELEMETRY_LIMITS.networkWaitRetryMaxMs = 300_000`.
   - Add to the transport outcome union:
     `{ kind: "waiting"; detail: string; retryAfterMs: number | null }`.
   - Add to both `TelemetryProfileHealth` and `TelemetryProfileSummary`:
     - `waitingForNetwork: boolean`;
     - `waitingSince: number | null`;
     - `latePointsSent: number`.

   `waiting` is deliberately not a pause reason: a pause stops delivery, and this must not.
2. **Durable watermark (`src/server/telemetry/schema.ts`, `migrateTelemetry`).**
   - Add nullable columns to `telemetry_series` with `addTelemetryColumn`:
     - `exported_value REAL`;
     - `exported_histogram_json TEXT` (count, sum and bucket counts only);
     - `exported_end INTEGER`;
     - `exported_generation INTEGER`.
   - Add `waiting_since INTEGER` to `telemetry_destinations`.
   - Update the fresh `CREATE TABLE` definitions too.
   - Keep the byte accounting in `usedBytes` correct: the columns are on an already-charged
     table, so confirm the per-row estimate still covers them.
   - Add the pre-feature upgrade test the database contract requires.
3. **Delta building (`src/server/telemetry/projection.ts`).**
   - Thread a per-profile export descriptor, `{ temporality, generation }`, from
     `runProjectionPass` through `runOne` into `Collector`.
   - In `Collector.apply`, for a delta destination, each touched series is handled by kind:
     - **Counter:** `delta = value - (exported_value ?? 0)` when `exported_generation` equals the
       current generation. Otherwise the baseline rule in step 4 applies.
     - **Histogram:** difference count, sum and each bucket. Omit `min` and `max`, which cannot
       be differenced.
     - **Gauge:** send the current value if it differs from `exported_value`. Otherwise skip it
       here; an unchanged gauge is sent only by the heartbeat below.
     - **Zero deltas and unchanged gauges are not written into the batch at all.**
   - **The heartbeat.** It guarantees that a gauge a projection still maintains reports at
     least hourly, even with no events. For a delta destination:
     - **Owner.** `CATALOG_PROJECTION`'s pass owns it for every gauge that projection
       contributes. The analytical projection already re-emits hourly through its own
       `idleSnapshots`, so its gauges are excluded here and never sent twice.
     - **Due set.** A gauge series is due when all of these hold:
       - it is in the profile's current policy epoch;
       - its instrument is a catalog gauge;
       - its `exported_end` is at least one hour before the pass clock;
       - its `last_time` is within `payloadRetentionMs`, so a gauge whose source stopped
         reporting days ago is not resurrected.
     - **Selection.** Find the due set with one query over a new index,
       `idx_telemetry_series_heartbeat` on `(profile, policy_epoch, exported_end)`. Create the
       index in `migrateTelemetry` after the columns in step 2 exist, as the database contract
       requires.
     - **Idle passes.** When the due set is non-empty, `runOne` for `CATALOG_PROJECTION` does
       not return early on a pass with no journal events. It reduces nothing and advances no
       checkpoint, but still builds a batch holding only the due gauges.
     - **Points.** Each due gauge is written with its current value, `startTimeMs` at its
       previous `exported_end` and `endTimeMs` at the pass clock, and its `exported_*` updated
       in the same transaction. It therefore heartbeats at most once per hour.
     - **In practice.** The health gauges are touched every cycle, so their changing values,
       `observed_at` among them, are sent every cycle while the daemon runs. The heartbeat is the
       guarantee for any catalog gauge that is not touched, or during a capture gap.
   - **Point times.** `startTimeMs` is the previous `exported_end`, or the series start for a
     first export. `endTimeMs` is the pass clock `now`, bumped by 1 ms if needed so it is always
     strictly greater than `exported_end`.
     - The pass clock is used, not the event time, because a delta must describe a window that
       never overlaps the previous one.
     - Record in the docs that a late fact is attributed to the pass that projected it.
   - Write the new `exported_*` values in the same transaction that writes the batch.
   - Add `temporality: "delta"` to each `MetricPointDto` written this way. Default batches carry
     no new field, which keeps the existing byte-for-byte pins intact.
4. **Baseline on endpoint change (`src/server/telemetry/config.ts`).** In the same transaction
   that bumps `generation` for a profile whose destination is, or becomes, `delta`:
   - set `exported_value`, `exported_histogram_json` and `exported_end` of that profile's
     current-epoch series to their current values;
   - set `exported_generation` to the new generation.

   The first delta a new endpoint receives then describes only what happened after it was
   addressed, never the whole history. Do the same when `temporality` itself changes from
   `cumulative` to `delta`, and record that switch as a destination change that also bumps
   `generation`. A series with no watermark for the current generation was created after the
   baseline, so its baseline is zero.
5. **Serialization (`src/server/telemetry/otlp.ts`).** `toMetricData` uses
   `AggregationTemporality.DELTA` for sums and histograms whose point carries
   `temporality: "delta"`, and `CUMULATIVE` otherwise. Gauges are unaffected.
6. **Network gate (`src/server/telemetry/delivery.ts`).**
   - Pass the destination's `networkGate` into `send` / `classify`.
   - When the gate is `cloudflare-edge`, a 403 whose response carries a `cf-ray` header and a
     `server` header of `cloudflare`, and whose content type is not an OTLP content type
     (`application/x-protobuf` or `application/json`), becomes
     `{ kind: "waiting", detail: "The destination's network edge refused this network", retryAfterMs }`.
   - Every other 401 and 403, and every 403 on an ungated destination, still pauses exactly as
     today.
   - This fingerprint is Cloudflare's documented edge response. It is tested here only against
     a fake collector. Phase 6's pilot captures the real gateway's off-VPN response before
     default-on, and owns any correction.
7. **Settling a wait.**
   - `settle` schedules the batch at `retryAfterMs ?? backoff(attempts)`, with the ceiling
     `networkWaitRetryMaxMs` for this outcome only.
   - It sets `waiting_since` if null, leaves `pausedReason` null, and never pauses.
   - An accepted response clears `waiting_since`.
   - A waiting outcome stops the rest of that signal's pass, as a retry does today, so a
     refused network is not hammered.
8. **Late points.**
   - When `lateAfterMs` is set and a batch being sent contains points whose `endTimeMs` is older
     than `now - lateAfterMs`, the batch is still sent. Its point count is added to a durable
     `late_points_sent` counter on `telemetry_destinations`, added with `addTelemetryColumn`.
   - The counter is exposed as `latePointsSent`, and a `late_points` gap reason is recorded, so
     the loss is visible where the backend drops them.
9. **Probe (`src/server/telemetry/diagnostics.ts`).**
   - A `waiting` outcome maps to the existing `unreachable` result, with the gate's detail, so
     the probe enum does not change.
10. **Health and summary (`src/server/telemetry/health.ts`, `src/server/registry.ts`).**
    - Populate `waitingForNetwork`, `waitingSince` and `latePointsSent`.
    - Add all three to `sameTelemetrySummary` and to `test/settings-status.test.ts`.
    - A waiting destination is not `failing`.
11. **Settings > Telemetry (`src/web/components/TelemetrySettingsPanel.tsx`,
    `src/web/lib/settings-dots.ts`).**
    - When a destination is waiting, the health block reads "Waiting for network access to
      this destination. Queued data is kept and sent when it can get through." It does not use
      the failing sentence.
    - The rail dot for a waiting destination is neutral, not red.
    - Phase 3 replaces "this destination" with an organization's label. Keep the sentence in
      one function that takes an optional label, so Phase 3 only passes one in.
    - Add an editable **Metric temporality** select to both remote destinations (Your own
      backend, Product analytics):
      - its options are "Cumulative (Prometheus, Grafana)" and "Delta (Datadog)";
      - its accessible label is "Metric temporality for <destination>";
      - it saves with that destination's existing Save button, in the same
        `PUT /api/telemetry/config` with `ifRevision`.
    - Render the select through one component that takes an `editable` flag, so Phase 3 can
      hide it on a managed Mac without duplicating the control.
12. **Route surface.** Update `test/fixtures/route-surface.json` for the changed
    `GET /api/telemetry/config` and `GET /api/telemetry/health` bodies. No route is added.
13. **Docs (`docs/observability.md`).**
    - Document the three fields and the `PUT` that sets them, with a delta example.
    - Document the waiting state and the late-points counter.
    - Add a delta subsection to "Why cumulative": what a lost or re-sent delta batch means, and
      that the cumulative default keeps every earlier guarantee.

## 6. Data, API and compatibility

- **Upgrade.** Every new field has a default equal to today's behaviour, and every new column
  is nullable, so an upgraded database behaves identically until someone opts in.
- **Queued batches.** A batch built before this phase has no `temporality` field, and it is
  cumulative by definition.
- **What delta gives up, stated plainly.**
  - A delta batch that is lost is lost data. That covers expiry after 7 days, pressure shedding,
    a 400 or 413 rejection, a partial success, and the stale-generation fence.
  - A delta batch re-sent after an ambiguous acknowledgement is repeated data, unless the
    backend overwrites a point with the same series and timestamp.
  - All of these are already counted as gaps or retries. Say so in the docs; do not try to
    reconstruct.
- **API.** `PUT /api/telemetry/config` accepts the three fields under `user` and `product`. The
  existing revision and conflict rules apply unchanged.
- **Wire.** `GET /api/telemetry/config` and `GET /api/telemetry/health` gain fields, which is
  additive.

## 7. Tests and verification

Unit tests, using the single-file command from `AGENTS.md`:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/<file>.test.ts
```

- `test/telemetry-contract.test.ts`:
  - the cumulative pin at 177 stays green;
  - add that a point carrying `temporality: "delta"` serializes with delta for sums and
    histograms, and that gauges are unchanged.
- A new `test/telemetry-delta.test.ts`:
  - counters and histograms export differences across three passes;
  - a zero delta is omitted;
  - gauges are sent on change and not otherwise within the hour;
  - **a full idle hour.** With health capture stubbed off, no journal events for 61 minutes
    after a gauge's last export:
    - the next pass returns a batch holding exactly that gauge, with its unchanged value,
      `startTimeMs` at the previous export and `endTimeMs` at the pass clock;
    - the checkpoint does not move;
    - at 59 minutes the pass writes nothing;
    - repeated passes within the next hour write nothing more;
    - a gauge whose `last_time` is 8 days old is not heartbeated;
    - analytical gauges are not selected by the catalog heartbeat;
  - restart and replay neither repeat nor lose a window;
  - an endpoint change baselines, so the first delta excludes the history;
  - `cumulative → delta` baselines the same way;
  - `endTimeMs` is strictly increasing per series;
  - `min` and `max` are absent from delta histograms.
- `test/telemetry-transport.test.ts`:
  - a gated destination given a Cloudflare-shaped 403 waits, keeps retrying under the 5-minute
    ceiling, and never pauses;
  - the same 403 on an ungated destination still pauses `auth`;
  - a gated destination given a 403 without `cf-ray`, or with an OTLP content type, still
    pauses;
  - an accepted response clears the wait;
  - the 60-second ceiling test at 573 is unchanged.
- `test/telemetry-durability.test.ts` and `test/telemetry-analytics-durability.test.ts` pass
  unchanged. They exercise the default cumulative path.
- The database upgrade test covers a pre-feature telemetry schema opening cleanly.
- `test/settings-status.test.ts` and `test/route-surface-oracle.test.ts` are updated for the new
  leaves.

E2E: a new `e2e/specs/telemetry-network-wait.spec.ts`.
- The local fake collector answers 403 with `cf-ray` and `server: cloudflare`.
- The spec sets `networkGate: "cloudflare-edge"` on the product destination through the API.
- It asserts the waiting sentence in Settings > Telemetry, a neutral rail dot, and that the
  switch stays on with no pause control shown.
- Then the collector accepts, and the spec asserts the wait clears.

E2E: extend `e2e/specs/telemetry-settings.spec.ts`:
- choose "Delta (Datadog)" for Your own backend, save, and reload;
- the select still reads Delta;
- `GET /api/telemetry/config` reports `temporality: "delta"` for `user`;
- Product analytics is unchanged.

Suite:

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npx playwright install chromium   # once per machine
npm run test:e2e
```

## 8. Merge and exit criteria

- Every existing telemetry test passes without edits to its assertions, except the
  route-surface fixture and the settings-status leaf list, which grow.
- The new unit and e2e tests pass. Typecheck, lint, build and smoke pass.
- `docs/observability.md` documents delta, the waiting state and late points.
- A default installation's batches are byte-identical to before this phase.

## 9. Downstream handoff

Later phases may rely on these, and must not change them without an audit entry here:

- **Config fields.** `temporality`, `networkGate` and `lateAfterMs` on
  `TelemetryDestinationSchema`, with those names, values and defaults.
- **Point field.** `temporality: "delta"` on `MetricPointDto`, with absence meaning cumulative.
- **Watermark.** The `exported_*` columns on `telemetry_series`, and the rule that an endpoint
  or temporality change baselines them. Phase 2 extends the baseline rule to shape changes; it
  does not replace it.
- **Outcome and health.** The `waiting` outcome, `waitingForNetwork`, `waitingSince` and
  `latePointsSent`, and the one sentence function that takes an optional organization label.
- **Heartbeat.** The gauge rule: sent on change, and otherwise heartbeated by
  `CATALOG_PROJECTION`'s pass at most an hour after its last export, even in a pass with no
  events. Analytical gauges keep their own hourly snapshots. Phase 2's budget counts a gauge
  series as live while it heartbeats, and Phase 5's adoption query relies on the health
  `observed_at` gauge reporting at least hourly.
- **Temporality control.** The editable "Metric temporality" select, with its `editable` flag.
  Phase 2 adds the "Export shape" select beside it, and Phase 3 hides both on a managed Mac.

## 10. Cross-phase audit record

- 2026-09-28, written first. It owns the destination capability fields that every later phase
  consumes. It chooses the pass clock for delta end times and the generation baseline, which
  are the two rules Phase 2's shape reset must reuse.
- 2026-09-29, repair round 1:
  - Added the editable temporality control, following the human decision that people on
    machines that are not Upstart-managed edit their telemetry settings, including what they
    need to configure Datadog by hand.
  - Redacted the gateway's replica count and access description for the public repository.
- 2026-09-29, repair round 5:
  - The heartbeat was promised without a mechanism: a pass with no events returns early, and
    batches hold only touched series. It is now specified: the owning projection, the due-set
    query and index, running despite the idle early return, and a full-idle-hour test.
  - The real-gateway checks (the delta replay behaviour and the real off-VPN response) are
    stated as Phase 6's, matching the root plan. This phase builds the gate to Cloudflare's
    documented edge response against a fake collector. If Phase 6's capture differs, the
    fingerprint correction is recorded here.
