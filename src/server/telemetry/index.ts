/**
 * The telemetry facility's public face inside the daemon.
 *
 * A source owner needs `captureTelemetry` and a catalog entry, and nothing else here. Routes
 * need the config and health readers. The entry point needs `startTelemetry`. Everything else
 * - the store, the projection engine, the exporter - is internal, and reaching past this
 * barrel for it is the shape of coupling that would make a later phase's change unreviewable.
 */
export { captureTelemetry, resourceAttributes } from "./capture.ts";
export type { CaptureRequest } from "./capture.ts";
export {
  getTelemetryConfig,
  resetTelemetryIdentity,
  setTelemetryConfig,
  telemetryIdentity,
  telemetryProductEnrollment,
  telemetryStatus,
  userCredentialConfigured,
} from "./config.ts";
export {
  recordTelemetryControl,
  runTelemetryOperation,
  telemetryCollectionEnabled,
} from "./controls.ts";
export { observeDaemonStart, runTelemetryProbe } from "./diagnostics.ts";
export type { DaemonLaunchMode } from "./diagnostics.ts";
export { telemetryHealth, telemetrySettingsSummary } from "./health.ts";
export { admitBrowserTelemetry, resetIngressRateLimitForTesting } from "./ingress.ts";
export {
  expirePrObservations,
  prKeyFor,
  recordTelemetryPrMerges,
  registerPrTelemetrySource,
  repoKeyFor,
  retainPrObservation,
  telemetryPrCohortInputs,
  telemetryPrPollTargets,
} from "./pr-observations.ts";
export type { RetainedPrObservation } from "./pr-observations.ts";
export {
  attachSessionTelemetry,
  noteDaemonShuttingDown,
  noteDispatchLaunch,
  noteDispatchStarted,
  noteSessionHandoff,
  noteSessionRestoring,
  noteTaskDeparture,
  observeDispatchFinished,
  observeEffortSelected,
  observeKillRequested,
  observeSessionOperation,
  observeSessionRestore,
  observeUsageRecorded,
  registerSessionTelemetrySource,
  resetSessionTelemetryForTesting,
} from "./sessions.ts";
export type { SessionTelemetryHost } from "./sessions.ts";
export {
  registerTelemetryProjection,
  registerTelemetrySource,
  registeredProjections,
  registeredSources,
  resetTelemetryRegistrations,
} from "./registration.ts";
export type {
  EmittedSpan,
  TelemetryEmitter,
  TelemetryProjection,
  TelemetrySource,
} from "./registration.ts";
export {
  noteTelemetryRunStart,
  noteTelemetryRunStopped,
  recordUnknownGapOnRecovery,
  runRetentionPass,
} from "./retention.ts";
export {
  registerBuiltinTelemetry,
  runTelemetryCycle,
  telemetryCycle,
  startTelemetry,
  TELEMETRY_CYCLE_MS,
} from "./service.ts";
export type { TelemetryService } from "./service.ts";
