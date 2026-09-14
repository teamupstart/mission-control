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
export { observeDaemonStart, runTelemetryProbe } from "./diagnostics.ts";
export type { DaemonLaunchMode } from "./diagnostics.ts";
export { telemetryHealth } from "./health.ts";
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
export { runRetentionPass } from "./retention.ts";
export {
  registerBuiltinTelemetry,
  runTelemetryCycle,
  startTelemetry,
  TELEMETRY_CYCLE_MS,
} from "./service.ts";
export type { TelemetryService } from "./service.ts";
