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
    tags, and that `host` is otherwise the gateway pod.
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
       weight is 9 while the gateway keeps `send_aggregation_metrics: true`, and 5 if its owners
       turn it off. Keep it one editable number.
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
4. **Weighted, live budget (`fold`).**
   - When the shape has a `seriesBudget`, admitting a new series checks the profile's weighted
     live series count plus the new series' weight against the budget.
   - Live means: current policy epoch, and a `last_time` or `exported_end` within
     `payloadRetentionMs` (7 days). Phase 1's gauge heartbeat keeps a reporting gauge live.
   - Weight is taken from the shape by the series' exported kind: a distribution, a histogram
     exported as sum and count, a counter or a gauge.
   - Over budget folds into the existing overflow path and records the existing
     `series_overflow` gap.
   - The existing 2,000 and 10,000 caps still apply to every shape. The budget is an additional,
     tighter bound, never a looser one.
5. **Applying the shape at batch build (`Collector.apply`, `toPoint`).**
   - A histogram that is not a distribution under the shape is written as two counter points,
     `<name>.sum` (the histogram's unit) and `<name>.count` (unit `1`). They use the Phase 1
     delta rules over the histogram watermark's sum and count.
   - Add the shape's `resourceAttributes` to the batch payload's resource at build time, so the
     digest covers them and a queued batch never changes on the wire.
   - The probe payload in `diagnostics.ts` adds the same attributes for its destination's shape.
6. **Changing shape (`src/server/telemetry/config.ts`).** When `exportShape` changes for a
   profile, in the same transaction:
   - bump `generation`, which fences queued batches of the old shape exactly as an endpoint
     change does;
   - delete that profile's `telemetry_series` rows;
   - record a `shape_changed` gap.

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
- **Budget:**
  - weighted admission;
  - overflow at the boundary;
  - a series 8 days idle is not live;
  - the 10,000 cap still applies.
- **Shape change:**
  - generation bumped, queued lean batches fenced, series restarted;
  - unprojected journal facts still projected under the new shape.
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
  probe. Phase 6's pilot verifies that it collapses the pod split without creating billable
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
