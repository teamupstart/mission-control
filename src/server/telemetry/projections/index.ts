import { ANALYTICAL_PREFIX, ANALYTICAL_METADATA, ANALYTICAL_WINDOW, ANALYTICAL_HORIZON } from "@shared/telemetry-projections/index.ts";
import { registerTelemetryProjection, type TelemetryProjection } from "../registration.ts";
import { calculateAnalytics } from "./calculate.ts";
import { WINDOW, expireAnalyticalState, initialAnalyticalState, reduceAnalyticalEvent, type AnalyticalState } from "./state.ts";

export const ANALYTICAL_PROJECTION: TelemetryProjection<AnalyticalState> = {
  id: "mission.analytics.v1",
  stateVersion: 1,
  idleSnapshots: true,
  initialState: initialAnalyticalState,
  // A future incompatible state resets with the engine's unsupported-schema gap. It cannot
  // reuse v1's stream meaning by guessing how to interpret a different shape.
  migrateState: (state, version) => version === 1 ? state as AnalyticalState : null,
  reduce: (event, state, _emit, ctx) => reduceAnalyticalEvent(event, state, ctx.now, ctx.resource?.["service.version"]),
  snapshot(state, emit, ctx) {
    expireAnalyticalState(state, ctx.now);
    state.since ??= ctx.now;
    if (!ctx.caughtUp || ctx.now <= state.lastCalculatedAt) return;
    // Dirty snapshots follow the collection cadence; quiet installations refresh hourly.
    // Day-scale cohorts do not need a full outbox snapshot every thirty seconds offline.
    if (ctx.now - state.lastCalculatedAt < 30_000) return;
    if (!state.dirty && state.lastCalculatedAt > 0 && ctx.lastGapAt === state.lastGapAt
      && ctx.now - state.lastCalculatedAt < 3_600_000) return;
    const snapshots = calculateAnalytics(state, ctx.now, { lastGapAt: ctx.lastGapAt, caughtUp: ctx.caughtUp });
    for (const snapshot of snapshots) {
      const dimensions = { window: ANALYTICAL_WINDOW, horizon: ANALYTICAL_HORIZON,
        slice_by: snapshot.sliceBy, slice: snapshot.slice, audience: ctx.profile };
      const values = { ...snapshot.values,
        calculated_at: ctx.now / 1000, window_start: snapshot.from / 1000, window_end: snapshot.to / 1000,
        horizon: WINDOW / 1000, complete: Number(snapshot.complete),
        consent_epoch: ctx.policyEpoch,
        expected_points: Object.keys(snapshot.values).length + ANALYTICAL_METADATA.length,
        first_observed_at: (snapshot.firstObservedAt ?? 0) / 1000 };
      for (const [field, value] of Object.entries(values)) emit.metric(`${ANALYTICAL_PREFIX}.${snapshot.view}.${field}`, dimensions, value);
    }
    state.lastCalculatedAt = ctx.now;
    state.lastGapAt = ctx.lastGapAt ?? null;
    state.dirty = false;
  },
};

export function registerAnalyticalTelemetry(): void {
  registerTelemetryProjection(ANALYTICAL_PROJECTION);
}
