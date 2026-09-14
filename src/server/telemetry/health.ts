/**
 * The bounded health and readiness view.
 *
 * Phase 1 needs it because a walking slice with nothing to look at is a walking slice nobody
 * can debug; Phase 2 renders exactly this shape in Settings. Everything in it is a count, an
 * age or a closed enum. No endpoint, no credential, no payload, no entity identity - the
 * safest way to keep an operator-facing status view from becoming a second data leak is for it
 * to have nothing to leak.
 */
import {
  TELEMETRY_AUDIENCE_POLICY_VERSION,
  TELEMETRY_CATALOG_VERSION,
  TELEMETRY_ENVELOPE_VERSION,
  TELEMETRY_LIMITS,
  TELEMETRY_PROFILE_IDS,
  type TelemetryHealth,
  type TelemetryProfileHealth,
} from "@shared/telemetry.ts";
import {
  getTelemetryConfig,
  profileIsCapturing,
  profileIsExporting,
  peekTelemetryIdentity,
  telemetryProductEnrollment,
} from "./config.ts";
import {
  deliveryCounts,
  getDestination,
  getProjectionState,
  journalBacklog,
  listGaps,
  telemetryTransaction,
  usedBytes,
} from "./store.ts";
import { registeredProjections } from "./registration.ts";

export function telemetryHealth(now = Date.now()): TelemetryHealth {
  const config = getTelemetryConfig();
  return telemetryTransaction((d) => {
    const profiles: TelemetryProfileHealth[] = TELEMETRY_PROFILE_IDS.map((profile) => {
      const destination = getDestination(d, profile);
      const counts = deliveryCounts(d, profile);
      return {
        profile,
        capturing: profileIsCapturing(config, profile),
        exporting: profileIsExporting(config, profile),
        pausedReason: destination.pausedReason,
        destinationGeneration: destination.generation,
        policyEpoch: destination.policyEpoch,
        pending: counts.pending,
        retrying: counts.retrying,
        accepted: counts.accepted,
        rejected: counts.rejected,
        expired: counts.expired,
        oldestPendingAgeMs: counts.oldestPendingAt === null ? null : now - counts.oldestPendingAt,
        pendingBytes: counts.pendingBytes,
        lastError: destination.lastError,
        lastAcceptedAt: destination.lastAcceptedAt,
      };
    });

    // The backlog is measured against the SLOWEST projection and profile, because that is the
    // one that decides when a payload may be pruned. An average would hide exactly the
    // reducer that has stopped keeping up.
    let slowest: number | null = null;
    for (const projection of registeredProjections()) {
      for (const profile of TELEMETRY_PROFILE_IDS) {
        if (!profileIsCapturing(config, profile)) continue;
        const state = getProjectionState(d, projection.id, profile);
        const consumed = state?.consumedSeq ?? 0;
        slowest = slowest === null ? consumed : Math.min(slowest, consumed);
      }
    }

    // Peeked, never minted: an installation that has not opted in must leave no telemetry
    // trace, and a status poll is not consent.
    const identity = peekTelemetryIdentity();
    return {
      enabled: config.enabled,
      installationId: identity?.installationId ?? "",
      identityEpoch: identity?.epoch ?? 0,
      envelopeVersion: TELEMETRY_ENVELOPE_VERSION,
      catalogVersion: TELEMETRY_CATALOG_VERSION,
      audiencePolicyVersion: TELEMETRY_AUDIENCE_POLICY_VERSION,
      productEnrollment: telemetryProductEnrollment(),
      journalBacklog: slowest === null ? 0 : journalBacklog(d, slowest),
      usedBytes: usedBytes(d),
      maxBytes: TELEMETRY_LIMITS.maxTotalBytes,
      gaps: listGaps(d),
      profiles,
    };
  });
}
