# Phase 2: The lean export shape

Source plan: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome and value

A destination can name an **export shape** that changes what it receives, without touching
what any other destination receives. Two shapes ship:

- `full`, today's export, which is the default;
- `datadog-lean`, the cost-bounded shape the source plan's [Datadog cost](plan.md#datadog-cost)
  section requires.

With `datadog-lean` on a delta destination, the expected Datadog custom-metric count falls
from about 1,194 to about 92 per installation. A hard budget caps it at 1,500 in any hour.

Engineering value:

- one registry states exactly which metric names and labels a shape exports, and the Datadog
  dashboard validator (Phase 5) and the Settings display (Phase 3) read it rather than
  restating it;
- series from app versions that no longer run stop counting against the profile cap forever.

## 2. Entry criteria and dependencies

- Direct phase dependency: **Phase 1**. This phase uses its delta watermark, its point
  `temporality` field and its generation baseline rule.

## 3. Scope and non-goals

In scope:

- **Registry.** A shared shape registry with `full` and `datadog-lean`, and a manifest function
  listing what a shape exports.
- **Config.** An `exportShape` destination field, defaulting to `full`.
- **Applying a shape:**
  - excluded instrument families;
  - dropped labels;
  - minor histograms exported as sum and count counters;
  - a constant resource attribute;
  - a weighted, live-series budget.
- **Changing a shape** starts that destination's series again.
- **Pruning.** Series whose resource no longer contributes are removed after the 30-day reducer
  window.
- **An editable "Export shape" select** on each remote destination in Settings > Telemetry,
  beside Phase 1's temporality select. People on machines that are not Upstart-managed can then
  choose `datadog-lean` for a Datadog destination they configure themselves.
- **Docs**, in `docs/observability.md`.

Non-goals:

- choosing a shape for anyone automatically (Phase 3);
- hiding the controls on a managed Mac (Phase 3);
- the Datadog dashboard (Phase 5);
- any change to traces. Spans keep every attribute, which is where the dropped labels remain.

## 4. Repository findings and inherited contracts

Findings. Line numbers were taken on 2026-09-28 and will drift.

- **Contributions.** `Collector.metric` (`src/server/telemetry/projection.ts:409-447`) applies
  the audience filter, keeps only `definition.dimensions`, maps a missing key to `unknown`, and
  records any extra key as an undeclared dimension.
- **Caps.** `fold` (680-755) checks the two caps only when a series is new:
  - `seriesCountForInstrument` is per epoch and resource;
  - `seriesCountForProfile` (`store.ts:531-536`) is `WHERE profile = ?`, which counts every
    epoch and every resource ever seen.

  Overflow sets every declared dimension to `__overflow__`.
- **No pruning.** Series rows are never pruned by retention. Only `purgeProfileQueue` deletes
  them, so series from old app versions keep counting toward the 10,000 profile cap forever.
  This is a latent defect that this phase fixes for every shape.
- **Batch building.**
  - Batches are built per resource in `Collector.apply` (481-589), from `toPoint` (781-808).
  - The batch payload copies the resource at build time and is covered by `digest(payload)`.
  - The probe builds its own payload from `resourceAttributes()` (`diagnostics.ts:125`).
- **Datadog behaviour.**
  - Datadog resolves a host from the resource attributes `host`, then `datadog.host.name`,
    then cloud and Kubernetes conventions, then `host.id` and `host.name`. Its docs recommend
    `datadog.host.name`. Source: Datadog OTLP hostname mapping documentation, read
    2026-09-28.
  - The validation point showed that `service.instance.id` and data-point attributes become
    tags, and that `host` is otherwise the receiving gateway instance.
- **Span attributes.** Every trimmed label still exists on its span:
  - as a span attribute for the session, dispatch, turn, segment, operation and effort events;
  - as `mission.actor.kind` / `origin` / `basis`, which every span carries
    (`projection.ts:153-165`), for the two `actor` drops.

  This was checked by reading `TELEMETRY_EVENTS[...].span.attributes` on 2026-09-28.

Inherited from Phase 1:

- **Watermark and baseline.** The `exported_*` watermark columns and the baseline rule on an
  endpoint or temporality change.
- **Point times.** The pass-clock end time, strictly increasing per series.
- **Point field.** `temporality: "delta"` on `MetricPointDto`.
- **Gauge rule.** Gauges are sent on change, with an hourly heartbeat.

## 5. Implementation steps, in order

1. **Shape registry (`src/shared/telemetry-export-shapes.ts`, browser-safe with no `node:`
   imports).**
   - `TELEMETRY_EXPORT_SHAPE_IDS = ["full", "datadog-lean"] as const`. It is persisted in the
     config blob, so it is append-only: add it to the persisted-identifier list in
     `docs/agent-guides/change-contracts.md`.
   - A `TelemetryExportShape` record per id, holding:
     - `label` and `summary`: the sentence Settings prints about what the shape leaves out;
     - `excludedPrefixes: string[]`;
     - `droppedDimensions: Record<string, string[]>`;
     - `distributionHistograms: "all" | string[]`: histograms kept as distributions, with every
       other histogram exported as `<name>.sum` and `<name>.count` counters;
     - `resourceAttributes: Record<string, string>`;
     - `seriesBudget: number | null`;
     - `weights: { distribution: number; sumCount: number; counter: number; gauge: number }`.
   - `full` is the identity:
     - no exclusions and no drops;
     - `distributionHistograms: "all"`;
     - no attributes and no budget.
   - `datadog-lean` holds exactly the source plan's values:
     - **Excluded:** `mission.analytics.v1.`.
     - **Dropped labels:**
       - `mission.dispatches`: `resolution_source`, `resolved_effort`;
       - `mission.action.count`: `actor`;
       - `mission.sessions.ended`: `ended_while_work_open`;
       - `mission.session.segments`: `quality`, `reason`;
       - `mission.sessions.started`: `start_observation`;
       - `mission.session.operations`: `actor_basis`;
       - `mission.session.turns`: `quality`;
       - `mission.session.effort.selections`: `applies`;
       - `mission.automation.actions`: `actor`.
     - **Distributions:** `mission.session.turn.duration`, `mission.dispatch.duration`,
       `mission.workflow.duration`, `mission.workflow.node.duration`.
     - **Resource attribute:** `{ "datadog.host.name": "mission-control" }`.
     - **Budget:** `seriesBudget: 1500`.
     - **Weights:** `{ distribution: 9, sumCount: 2, counter: 1, gauge: 1 }`. The distribution
       weight is 9 while the gateway sends separate aggregation metrics for each histogram
       (internal notes, Gateway), and 5 if its owners stop. Keep it one editable number.
   - `exportedInstruments(shapeId, catalog = TELEMETRY_METRICS)` returns what the shape
     actually exports: each exported name, its exported kind (`counter` / `gauge` /
     `distribution`), its exported label list, and the source instrument it came from.
     Phases 3 and 5 consume it. Nothing else may restate the lean rules.
   - A catalog-consistency check, pinned by a test:
     - every name in `droppedDimensions` and `distributionHistograms` exists in
       `TELEMETRY_METRICS`;
     - every dropped label is one of that instrument's dimensions;
     - every dropped label appears on its event's span attributes, or is `actor` (carried by
       the envelope).
2. **Config field.**
   - Add `exportShape: z.enum(TELEMETRY_EXPORT_SHAPE_IDS).default("full")` to
     `TelemetryDestinationSchema`, next to Phase 1's fields.
   - Update `test/fixtures/route-surface.json` for `GET /api/telemetry/config`.
3. **Applying the shape at contribution (`Collector.metric`).**
   - The collector receives the profile's shape through the descriptor Phase 1 introduced.
   - Skip an instrument matching an excluded prefix for that profile. This is not a problem or a
     gap: the shape chose it.
   - Filter the kept dimension list by `droppedDimensions`, so those contributions aggregate
     together.
   - Keep the undeclared-dimension check against the instrument's full dimension list, so a
     dropped label is never reported as a defect.
4. **Weighted, live budget (`fold`), with the overflow series paid for inside it.**
   - **Live** means: current policy epoch, and a `last_activity` within `payloadRetentionMs`
     (7 days).
     - `last_activity` is a new column on `telemetry_series`, equal to
       `max(last_time, exported_end)`. It is updated in the same statement whenever either
       changes, and indexed by `idx_telemetry_series_live` on
       `(profile, policy_epoch, last_activity)`, created in `migrateTelemetry` after the column
       exists.
     - Phase 1's gauge heartbeat keeps a reporting gauge live.
     - Liveness is evaluated at the moment of the check, so a series that has aged out stops
       counting immediately and needs no sweep to free its room.
   - **Weight** comes from the shape, by the series' exported kind: a distribution, a histogram
     exported as sum and count, a counter or a gauge.
   - **The overflow series.** Each `(resource, instrument)` pair has at most one overflow series,
     with every declared dimension set to `__overflow__`. Its weight is the instrument's weight.
   - **Reservation.** A pair holds a reservation of that weight once it has at least one live
     series and its overflow series does not exist yet. When the overflow series is created it
     is counted as live, and the reservation ends.
   - **Committed weight** = weighted live series + reservations, over the profile's current
     epoch.
   - **Admission applies to every contribution for a series that is not live right now.**
     Admission is not only for series being created. Today's caps in `fold` check only when a
     series is new (`projection.ts:696-697`). The budget must also check a stored series that
     has aged out of live and now receives a contribution again, which is a resumed series.
     Otherwise it could fill up behind other series and bypass admission. A contribution to a
     series that is already live needs no admission.
   - **Admitting a new or resumed non-overflow series** requires
     `committed + weight(series) + (the pair's reservation, if it has none yet) <= seriesBudget`.
     The pair's first live series therefore also reserves room for its overflow series.
   - **A resumed series that does not fit** is handled exactly like a new one that does not
     fit, below. Its contribution goes to the overflow series or is dropped, not to the stored
     row. So the row's value, `last_time` and watermark stay as they were, and it stays not
     live. If it is later admitted, its next delta is computed from its own untouched
     watermark, so nothing that went to overflow is counted twice.
   - **Otherwise:**
     - if the pair holds a reservation or already has a live overflow series, the contribution
       folds into that overflow series. Creating it only converts the reservation, so committed
       weight never grows, and the existing `series_overflow` gap is recorded;
     - if the pair has neither, which only happens for a brand-new instrument or resource when
       the budget is already full, the contribution is dropped and a `budget_exhausted` gap is
       recorded, with the instrument name and a count.
   - **The invariant.** Committed weight never exceeds `seriesBudget`, so live series in the
     current epoch and shape, overflow included, never do either.
   - **What that invariant does not cover.** It is a steady-state bound. A shape change deletes
     the series rows, and a consent-epoch change starts a new set of series, but Datadog still
     counts the series already sent earlier in that hour. The billing guarantee is therefore
     enforced separately, at export time, by the hourly export ledger in step 5.
   - **Freeing room.** A pair whose series all age out of live releases its reservation too, so
     retired app versions free their room after 7 idle days. An overflow series that ages out
     stops counting the same way. If its pair has live series again, the reservation reappears
     by definition.
   - **Computing committed weight.** Compute it at admission time with one query over
     `idx_telemetry_series_live`. It needs no incrementally maintained counter, which could
     drift as series age out. Admissions only happen for new or resumed series, so the query
     is off the per-contribution path.
   - The existing 2,000 and 10,000 caps still apply to every shape. The budget is an additional,
     tighter bound, never a looser one.
5. **Applying the shape at batch build (`Collector.apply`, `toPoint`).**
   - A histogram that is not a distribution under the shape is written as two counter points,
     `<name>.sum` (the histogram's unit) and `<name>.count` (unit `1`). They use the Phase 1
     delta rules over the histogram watermark's sum and count.
   - Add the shape's `resourceAttributes` to the batch payload's resource at build time, so the
     digest covers them and a queued batch never changes on the wire.
   - The probe payload in `diagnostics.ts` adds the same attributes for its destination's shape.
   - **The hourly export ledger.** This is the hard billing guarantee, for a destination whose
     shape has a `seriesBudget`. It limits what is actually exported in each clock hour,
     whatever happened to series rows, shapes or epochs in between.
     - **Storage.** A new table, `telemetry_export_hours (profile, hour_start, series_digest, weight)`,
       keyed by profile and UTC hour of the point's `endTimeMs`. It is **not** keyed by policy
       epoch or shape, so it survives shape changes, consent-epoch changes, series deletion and
       restarts.
     - **The digest** is taken over what Datadog sees as one custom metric for that point:
       - the exported metric name;
       - the exported data-point attributes;
       - the batch resource's attributes, including the shape's constant host attribute,
         `service.version` and `deployment.environment.name`.

       The `weight` is the shape weight of its exported kind.
     - **Admitting a point to a batch.** A point whose digest is already in that hour's ledger
       costs nothing more. Otherwise it is added only if the hour's summed weight plus its own
       stays within `seriesBudget`. Otherwise it is **deferred**:
       - its watermark is not advanced, so a counter's or histogram's delta carries into the
         next hour's batch whole, with nothing lost;
       - a deferred gauge sends its then-current value next hour;
       - an `hourly_cap_deferred` gap is recorded with a count;
       - ledger rows are written in the same transaction as the batch.
     - **Admission happens once, when the batch is built.** A point's `endTimeMs` is the pass
       clock (Phase 1), so every admission is to the hour the pass runs in. Delivery never
       admits: a batch delivered late, for example after a day offline, was admitted when it
       was built and goes out unchanged, with no new ledger row for its hour.
     - **The high-water hour.** This is, per profile, the latest hour any point was admitted
       to. It is the latest `hour_start` in the table for that profile, which the sweep never
       deletes, so it needs no extra column.
       - A point whose hour is earlier than the high-water hour minus one is **deferred**
         rather than admitted. That only happens if the wall clock moves backwards.
       - So an hour whose rows were already swept can never be granted a fresh allowance.
       - The point is admitted once the pass clock is back inside the retained window, with
         its delta whole.
       - In practice only a series with no export inside the retained window waits, because
         Phase 1 keeps each series' `endTimeMs` strictly increasing past its last export.
     - **Retention.** The sweep deletes rows for hours earlier than the high-water hour minus
       one, and charges them to the byte budget. Because of the two rules above, no point can
       still be admitted to a swept hour. `purgeProfileQueue` and the shape and epoch resets
       deliberately keep the retained rows and the high-water hour.
     - **The guarantee.** In every clock hour, measured by point timestamp, a destination
       admits, and therefore exports, distinct series whose weights sum to at most
       `seriesBudget`. That holds across shape and epoch changes, restarts, late delivery and a
       wall clock that moves backwards.
     - **What it does not control.** How Datadog bills a backlog delivered late, for example
       after a day offline with Historical Metrics Ingestion enabled: the ledger fixes what is
       sent for each hour, not when Datadog counts it. Phase 6's pilot measures that case.
6. **Changing shape (`src/server/telemetry/config.ts`).** When `exportShape` changes for a
   profile, in the same transaction:
   - bump `generation`, which fences queued batches of the old shape exactly as an endpoint
     change does;
   - delete that profile's `telemetry_series` rows;
   - record a `shape_changed` gap.

   **What the reset touches, and why that is enough.** These are repository facts checked on
   2026-09-29:
   - **Counter and histogram totals live only in `telemetry_series`.** `CATALOG_PROJECTION`,
     the projection that turns events into counters and histograms, holds no reducer state at
     all: its state type is `Record<string, never>` (`src/server/telemetry/projection.ts:135-139`).
     Deleting the profile's series rows therefore sets every counter and histogram for that
     profile to zero.
   - **Phase 1's watermark columns live on those same rows**, so they go with them. The next
     export of a series has no watermark for the new generation and baselines at zero, so a
     delta can never carry pre-change totals.
   - **Projection checkpoints are kept on purpose.** Each projection's journal checkpoint in
     `telemetry_projection_state` stays where it is:
     - facts already projected under the old shape are never projected again, which avoids
       double counting;
     - facts captured but not yet projected are projected once, under the new shape.
   - **The analytical projection keeps its retained facts.** It emits only gauges
     (`mission.analytics.v1.*`), recomputed from those facts on every snapshot. Re-emitting
     them after the reset gives each gauge its current population value, which is correct for
     a gauge and is never added to a counter. Under `datadog-lean` that family is excluded
     anyway.
   - **Queued batches** of the old shape are fenced by the generation bump, retained and then
     expired under the existing rules, and never sent.
   - **Future projections.** A projection that holds cumulative totals in its own state is now
     forbidden. Add that rule to the doc comment on `registerTelemetryProjection`, and have the
     shape-change test fail if a registered projection's state carries a non-empty counter
     total after a reset.

   New contributions then aggregate under the new shape from zero. Phase 1's baseline rule holds
   trivially, because there are no series left to baseline. Do not bump the policy epoch: that
   would skip journal facts captured but not yet projected.
7. **Pruning series that can no longer receive data (`src/server/telemetry/retention.ts`).**
   - The retention sweep deletes `telemetry_series` rows whose resource is not the process's
     current resource and whose `last_time` is older than `reducerStateRetentionMs` (30 days).
   - The current resource's series are never pruned, so cumulative continuity is unaffected.
   - Add the count to the health view's existing retention bookkeeping.
8. **Settings > Telemetry.** Add an editable **Export shape** select to both remote
   destinations, next to Phase 1's temporality select and through the same component with its
   `editable` flag.
   - Its options come from the registry: each shape's `label`, with its `summary` shown as the
     option's description.
   - Its accessible label is "Export shape for <destination>".
   - It saves with the destination's Save button. Because a shape change resets that
     destination's series (step 6), the panel states that in one line under the select before
     saving.
9. **Docs.**
   - In `docs/observability.md`, a new "Export shapes" section: the two shapes, what `datadog-lean`
     leaves out and why, the budget and its weights, the shape-change reset, and the prune.
   - Add `TELEMETRY_EXPORT_SHAPE_IDS` to the persisted-identifier list in
     `docs/agent-guides/change-contracts.md`.

## 6. Data, API and compatibility

- **Upgrade.** `exportShape` defaults to `full`, and `full` is the identity, so every existing
  destination's batches stay byte-identical. That keeps `test/telemetry-analytics-durability.test.ts:64`
  and the stack integration pins.
- **The prune is the one behaviour change for every installation.** It only removes series
  that a running build cannot contribute to, and only after 30 idle days. It is recorded, not
  silent.
- **Sum-and-count names.** `<name>.sum` and `<name>.count` must not collide with catalog names.
  Add a catalog-consistency assertion in `test/telemetry-export-shapes.test.ts` that no
  instrument ends in `.sum` or `.count`.
- **Where dropped labels remain.** They stay in source facts and on spans, so APM drill-down
  keeps them.

## 7. Tests and verification

Unit tests:

- **`test/telemetry-export-shapes.test.ts`:**
  - registry and catalog consistency, as in step 1;
  - `exportedInstruments("datadog-lean")` has no `mission.analytics.v1.*` names;
  - it has the four distributions and the seven sum-and-count pairs;
  - every trimmed metric's exported labels omit exactly the dropped ones;
  - `full` exports the catalog unchanged.
- **Projection tests over a real batch:**
  - a lean product destination and a full user destination fed the same events;
  - the lean batch has no analytics series, the host attribute, merged trimmed series, and
    sum and count counters for minor histograms;
  - the full batch is byte-identical to a pre-phase fixture.
- **Budget, at the boundary across several instruments:**
  - one counter, one gauge, one distribution histogram (weight 9) and one sum-and-count
    histogram (weight 2), across two resources;
  - fill committed weight to exactly `seriesBudget - 1`, then assert:
    - a new weight-1 series for a pair that already holds its reservation is admitted, and
      committed weight equals the budget;
    - a further series for that pair folds into its overflow series with no increase in
      committed weight;
    - a new pair's first series, which needs its own weight plus its reservation, is refused
      and counted as `budget_exhausted`;
    - a distribution series that would exceed the budget by 8 folds into its overflow series.
  - **Resumed series at the boundary.**
    - Series S of pair A goes 8 days idle and stops counting. Other series then fill committed
      weight to the budget, and then S receives a contribution. Assert all of these:
      - the contribution folds into A's overflow series when A holds a reservation or a live
        overflow series, or is dropped with a counted `budget_exhausted` gap when A holds
        neither;
      - S's stored value, `last_time` and watermark are unchanged, and S stays not live;
      - committed weight never exceeds the budget.
    - Then free room, and send S another contribution. Assert all of these:
      - S is admitted and resumes;
      - committed weight rises by exactly S's weight, plus A's reservation if A had none;
      - S's next delta excludes the contributions that went to overflow.
  - **A property test.** Randomized admissions, clock advances past the 7-day live window,
    and resumptions across the instruments and resources:
    - never let live weight plus reservations exceed `seriesBudget` at any step;
    - never create more than one overflow series per pair;
    - never let a resumed series bypass admission.
  - **Freeing room.** A series 8 days idle is not live, and its pair's reservation is released.
- **The hourly export ledger, across transitions:**
  - **Shape change within an hour.** In hour H, export series of weighted total W under
    `datadog-lean`, then change the shape in the same hour and generate enough new series to
    exceed `seriesBudget - W`. Assert:
    - the hour's exported weight never exceeds `seriesBudget`;
    - the surplus points are deferred and recorded as `hourly_cap_deferred`;
    - in hour H+1 the deferred counters' deltas arrive whole, with the sum across H and H+1
      equal to the contributions;
    - the ledger rows for H survive the shape reset.
  - **Epoch change within an hour.** The same, with consent withdrawn and re-given in hour H,
    starting a new policy epoch.
  - **Re-sending a known series.** A point for a series already in the hour's ledger is never
    deferred, even at the cap.
  - **Restart.** A daemon restart mid-hour keeps the ledger, and does not grant a fresh
    allowance.
  - **Rollover.** At the hour boundary the allowance resets, and rows for hours earlier than
    the high-water hour minus one are swept.
  - **Late delivery.** Build and admit a batch in hour H, keep the destination unreachable
    until H's rows are swept, then deliver. The batch goes out byte for byte, no ledger row is
    written for H, and nothing new is admitted to H.
  - **Clock moving backwards.** After H's rows are swept, set the pass clock back into H and
    produce a new series. It is deferred, never admitted to H, and is admitted with its delta
    whole once the clock returns inside the retained window.
  - **Other caps.** The 2,000 and 10,000 caps still apply alongside the budget.
- **Shape change, starting from nonzero totals with journal facts still pending:**
  - build nonzero counter, histogram and gauge totals on a delta destination, and export them
    once so the watermarks are set;
  - capture further facts that are not yet projected;
  - change the shape;
  - then assert:
    - the generation is bumped and queued old-shape batches are fenced;
    - the next batch's counter and histogram deltas equal exactly the pending facts, with none
      of the pre-change totals;
    - facts projected before the change are not counted again;
    - analytical gauges re-emit their current population values under a full shape, and are
      absent under `datadog-lean`;
    - every registered projection's state holds no counter totals.
- **Prune:**
  - old-resource series older than 30 days removed;
  - current-resource series kept at any age;
  - health bookkeeping updated.

E2E: extend `e2e/specs/telemetry-settings.spec.ts`:
- choose "Datadog lean" for Your own backend, read the reset line, save, and reload;
- the select still reads Datadog lean;
- `GET /api/telemetry/config` reports `exportShape: "datadog-lean"` for `user`;
- Product analytics still reads Full.

Suite:

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- A default installation's batches are byte-identical to Phase 1's.
- The lean shape's exported set equals the source plan's lean shape exactly, and is available
  from `exportedInstruments`.
- The docs and the persisted-identifier list are updated.
- The full suite is green.

## 9. Downstream handoff

Later phases may rely on these:

- **Shape ids.** `TELEMETRY_EXPORT_SHAPE_IDS`, with `full` and `datadog-lean`, and the
  `exportShape` field.
- **Manifest.** `exportedInstruments(shapeId)` as the one source of what a shape exports.
  Phase 5's dashboard validator and Phase 3's read-only display call it.
- **Label.** The `summary` sentence on each shape record, which Phase 3 prints.
- **Host attribute.** `datadog.host.name = mission-control` on lean batches and on the lean
  probe. Phase 6's pilot verifies that it collapses the instance split without creating billable
  hosts. If it does not, Phase 6 changes only the shape record's `resourceAttributes`.
- **Shape-change semantics:** a generation bump plus a series reset.
- **Shape control.** The editable "Export shape" select, rendered through Phase 1's component
  with its `editable` flag. Phase 3 hides it on a managed Mac.

Must not change without an audit entry: the lean shape's values, which are the source plan's
approved optimizations.

## 10. Cross-phase audit record

- 2026-09-28, written after Phase 1:
  - reuses Phase 1's descriptor, watermark and baseline;
  - extends the baseline rule to shape changes by resetting series instead of baselining
    them, which avoids exporting one merged delta across two different label sets;
  - no Phase 1 contract changed.
- 2026-09-28: the unpruned-series defect was found while designing the budget. Its fix belongs
  here because this phase owns series accounting, and the budget's notion of "live" depends on
  it.
- 2026-09-29, repair round 1: added the editable Export shape control, following the human
  decision that people on machines that are not Upstart-managed edit their telemetry settings.
  This phase now changes UI, so it gains an e2e spec.
- 2026-09-29, repair round 8:
  - The live-series budget alone could not guarantee the hourly ceiling. A shape change deletes
    series rows, and an epoch change starts new ones, while Datadog still counts what was sent
    earlier that hour.
  - Added the hourly export ledger: durable, keyed by profile and hour and not by epoch or
    shape. It limits distinct exported weight per clock hour, and defers the surplus without
    losing deltas.
  - The late-backlog case is handed to Phase 6's pilot as a measured check.
  - Phase 1's watermark is consumed unchanged, because a deferral simply does not advance it.
- 2026-09-29, repair round 6:
  - A stored series that aged out of live and then reported again could bypass admission,
    because today's caps check only new series.
  - Admission now applies to every contribution for a series that is not live right now.
    Liveness is evaluated at check time from an indexed `last_activity` column. Committed weight
    is computed at admission instead of maintained incrementally, so expiry cannot drift it.
  - A refused resume leaves the stored row untouched.
  - Added resumed-series boundary tests, and resumption in the property test.
  - No other phase's contract changed.
- 2026-09-29, repair round 5:
  - The hard budget sent over-budget combinations into overflow series that it never paid for,
    so it could be exceeded.
  - It now reserves each pair's overflow weight at the pair's first series, and admits against
    committed weight (live plus reservations). It drops a brand-new pair with a counted
    `budget_exhausted` gap when there is no room, and states the invariant.
  - The tests cover the boundary across several instruments and resources, plus a property
    test.
  - No other phase's contract changed.
- 2026-09-29, repair round 4: specified what a shape change resets across series, watermarks,
  projection checkpoints, analytical state and queued batches, and why no cumulative total can
  survive it. This is grounded in `CATALOG_PROJECTION` holding no state. Added a test that
  starts from nonzero totals with pending journal facts, and a rule forbidding projection-held
  cumulative totals. No other phase's contract changed.
- 2026-09-29, pull request review: the retention rule deleted an hour's rows after two hours,
  and the plan did not say whether a late batch could then admit series to that hour again.
  It now states that admission happens once, at batch build, in the pass clock's hour, so late
  delivery never admits. A high-water hour keeps a backwards wall clock from reopening a swept
  hour, and retention is defined against it. Tests cover late delivery and the clock moving
  backwards.
