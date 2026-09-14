/**
 * The two facts Phase 1 actually captures, and the source registration that owns them.
 *
 * Both are diagnostics about the telemetry facility and the daemon itself. That is the point:
 * the walking slice has to prove journal, projection, outbox, exporter, receiver, backend and
 * dashboard with a real fact, and the honest way to do that before any source phase has landed
 * is to observe something the daemon genuinely knows about itself - not to inject a fixture
 * into the pipeline and call the pipeline proven.
 */
import {
  SYSTEM_ACTOR,
  type TelemetryCaptureResult,
  type TelemetryProbeResult,
  type TelemetryProfileId,
} from "@shared/telemetry.ts";
import { DAEMON_STARTED_EVENT, TELEMETRY_PROBE_EVENT } from "@shared/telemetry-catalog.ts";
import { TELEMETRY_SCOPE } from "./projection.ts";
import { captureTelemetry, resourceAttributes } from "./capture.ts";
import { getTelemetryConfig, profileIsExporting, profileSalt, telemetryIdentity } from "./config.ts";
import { registerTelemetrySource } from "./registration.ts";
import { scopedTraceId } from "./projection.ts";
import { send, type DeliveryDeps } from "./delivery.ts";
import { serializeMetrics } from "./otlp.ts";
import { signalUrl } from "./endpoint.ts";

/**
 * A stable identity for THIS boot.
 *
 * Derived from the installation pseudonym and this process's start time, so the same boot
 * capturing twice deduplicates and two boots never collide. It is not a random id, because a
 * random one would make the dedupe test vacuous.
 */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

function bootId(): string {
  // `PROCESS_STARTED_AT` is computed ONCE at module load, not per call. Recomputing it drifts
  // by a millisecond or two between calls, which would give the same boot two identities and
  // make the dedupe that is supposed to protect it silently inert.
  return `${telemetryIdentity().installationId}:${PROCESS_STARTED_AT}`;
}

export type DaemonLaunchMode = "daemon" | "desktop" | "dev" | "unknown";

/**
 * Record that this daemon started and is serving.
 *
 * Called AFTER the port is answering, so `startupMs` measures what an operator would call
 * startup. Never on the critical path of the launch itself: backend availability is not a
 * launch condition, and a telemetry refusal here changes nothing about the daemon running.
 */
export function observeDaemonStart(input: {
  startupMs: number;
  schemaUpgraded: boolean;
  launchMode: DaemonLaunchMode;
  now?: number;
}): TelemetryCaptureResult {
  // BEFORE `bootId()`, and that ordering is the whole point rather than an optimisation.
  //
  // `bootId()` reads `telemetryIdentity()`, which MINTS and persists an installation pseudonym
  // on first read. Evaluating it as an argument meant a never-opted-in installation acquired
  // telemetry identity state simply by starting the daemon - `captureTelemetry` then correctly
  // returned `disabled`, but the row was already written. "Records nothing until an operator
  // opts in" has to include the identity, or default-off is a claim rather than a fact.
  //
  // Checked here rather than only inside `capture` because the leak is in building the
  // ARGUMENT, which no guard inside the callee can prevent.
  if (!getTelemetryConfig().enabled) return { kind: "disabled" };
  return captureTelemetry({
    event: DAEMON_STARTED_EVENT,
    source: { kind: "mission.daemon", id: bootId(), revision: 1 },
    actor: SYSTEM_ACTOR,
    facts: {
      startup_ms: Math.max(0, Math.round(input.startupMs)),
      schema_upgraded: input.schemaUpgraded,
      launch_mode: input.launchMode,
    },
    now: input.now,
  });
}

/**
 * Ask the configured destination whether it will take what this installation sends.
 *
 * Two halves, and both are needed:
 *
 * 1. A real OTLP/HTTP request with an EMPTY metrics payload. Valid protobuf, zero data points,
 *    so it exercises URL, TLS, credential, content-type and receiver routing without inventing
 *    activity. A receiver that answers this will answer a real batch.
 * 2. A captured `mission.telemetry.probe.finished` fact carrying the result, which then travels
 *    the ordinary durable path. So the probe reports connectivity immediately AND proves the
 *    whole pipeline on the next drain.
 *
 * The returned trace id is the per-profile scoped one, which is what an operator can actually
 * search for in the trace backend. Handing back the internal id would be a link that never
 * resolves.
 */
export async function runTelemetryProbe(
  profile: TelemetryProfileId,
  deps: Partial<DeliveryDeps> = {},
): Promise<TelemetryProbeResult> {
  const config = getTelemetryConfig();
  const endpoint = profile === "user" ? config.user.endpoint : config.product.endpoint;

  if (profile === "local" || !profileIsExporting(config, profile) || endpoint.trim() === "") {
    return {
      profile,
      outcome: "not_configured",
      latencyMs: 0,
      detail:
        profile === "local"
          ? "Local-only collection has no endpoint to probe."
          : "This destination is not enabled, has no endpoint, or is paused.",
      traceId: null,
    };
  }

  const resolved: DeliveryDeps = {
    fetch: deps.fetch ?? ((...args) => globalThis.fetch(...args)),
    now: deps.now ?? Date.now,
    // An operator-initiated probe is not part of the export cycle, so shutdown's cancellation
    // does not reach it. Its own request timeout is the bound.
    abort: deps.abort ?? null,
  };
  const body = serializeMetrics({ resource: resourceAttributes(), scope: TELEMETRY_SCOPE, metrics: [] });

  const started = resolved.now();
  const outcome = await send(signalUrl(endpoint, "metrics"), "metrics", body, profile, resolved);
  // AFTER the request, not before it. `occurredAt` is the moment the operation finished, and
  // the exported span is reconstructed as `[occurredAt - duration, occurredAt]`, so stamping it
  // with a clock read at the top of this function put the whole span before the probe began -
  // by the full round trip, which for an unreachable endpoint is the 10s timeout. That is
  // exactly the case an operator is most likely to be looking at. `observeDaemonStart` already
  // measures this way; this brings the probe in line with it.
  const finishedAt = resolved.now();
  const latencyMs = Math.max(0, finishedAt - started);

  const result: TelemetryProbeResult["outcome"] =
    outcome.kind === "accepted" ? "accepted" : outcome.kind === "retry" ? "unreachable" : "refused";
  const detail =
    outcome.kind === "accepted"
      ? (outcome.message ?? "The endpoint accepted an OTLP/HTTP request.")
      : outcome.detail;

  const captured = captureTelemetry({
    event: TELEMETRY_PROBE_EVENT,
    source: { kind: "mission.telemetry", id: `probe:${profile}:${started}`, revision: 1 },
    actor: { kind: "human", origin: "dashboard", basis: "app_context" },
    facts: { profile, outcome: result, latency_ms: Math.round(latencyMs) },
    occurredAt: finishedAt,
    now: finishedAt,
  });

  // Straight off this capture's own result. Nothing else in the process can substitute a
  // different operation's ids between the capture and the read, because there is no longer a
  // read: the correlation travels with the acceptance.
  const correlation = captured.kind === "accepted" ? captured.correlation : null;
  return {
    profile,
    outcome: result,
    latencyMs: Math.round(latencyMs),
    detail,
    traceId: correlation
      ? scopedTraceId(profile, profileSalt(profile), correlation.traceId)
      : null,
  };
}

/**
 * Register the daemon as a telemetry source.
 *
 * `recovers` is empty and `unrecoverable` is not, and that honesty is required rather than
 * decorative: a daemon that crashed before capturing its own start cannot reconstruct that
 * start later, because nothing durable records when a previous process began serving. P1 makes
 * every source say what it can and cannot rebuild, precisely so the next phase does not assume
 * a reconciliation exists where none does.
 */
const DAEMON_SOURCE = {
  id: "mission.daemon",
  recovers: [],
  unrecoverable: [
    "A start that crashed before capture. Nothing durable records when a previous daemon began serving.",
  ],
  maxScanPerTick: 0,
} as const;

const PROBE_SOURCE = {
  id: "mission.telemetry",
  recovers: [],
  unrecoverable: [
    "A probe whose result was never captured. It is an operator action, not a durable record.",
  ],
  maxScanPerTick: 0,
} as const;

/**
 * Module CONSTANTS rather than literals built per call, because `registerTelemetrySource`
 * refuses a second, different registration of the same id. Building a fresh object each time
 * would make the second call look like a competing owner trying to take the namespace.
 */
export function registerDaemonTelemetrySource(): void {
  registerTelemetrySource(DAEMON_SOURCE);
  registerTelemetrySource(PROBE_SOURCE);
}
