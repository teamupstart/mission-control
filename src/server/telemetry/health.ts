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
  type TelemetryProfileSummary,
  type TelemetrySettingsSummary,
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
import { HEALTH_EVENT } from "@shared/telemetry-sources/health.ts";
import { captureTelemetry } from "./capture.ts";

/** Bounded cadence and semantic identity also deduplicate concurrent manual drains. */
export function captureTelemetryHealth(now = Date.now()): void {
  if (!getTelemetryConfig().enabled) return;
  const health = telemetryHealth(now);
  for (const p of health.profiles) {
    if (!p.capturing) continue;
    captureTelemetry({ event: HEALTH_EVENT, profiles: [p.profile],
      source: { kind: "mission.telemetry.health", id: `${p.profile}:${p.policyEpoch}:${Math.floor(now / 30_000)}`, revision: 1 },
      facts: { profile: p.profile, pending: p.pending, retrying: p.retrying, accepted: p.accepted,
        rejected: p.rejected, expired: p.expired, pending_bytes: p.pendingBytes,
        oldest_pending_age: Math.max(0, p.oldestPendingAgeMs ?? 0) / 1000,
        last_accepted_at: (p.lastAcceptedAt ?? 0) / 1000, observed_at: now / 1000 },
      now, actor: { kind: "system", origin: "daemon", basis: "owner" },
    });
  }
}

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

/**
 * The bounded summary that rides the settings-status channel.
 *
 * A strict subset of `telemetryHealth`, computed separately rather than by trimming it, for one
 * reason that matters: this runs on EVERY settings-status recompose - every config write, every
 * task-source sweep, every dashboard connect - while the full health view runs only when a
 * panel asks for it. The two have different budgets and should not share a query plan.
 *
 * An installation that never opted in short-circuits before touching a telemetry table at all.
 * That is the state almost every installation is in, and the check is exact rather than a
 * guess: no identity has been minted means nothing has ever been captured, projected or queued,
 * because minting is what capture does first.
 */
export function telemetrySettingsSummary(now = Date.now()): TelemetrySettingsSummary {
  const config = getTelemetryConfig();
  const productEnrollment = telemetryProductEnrollment();
  if (peekTelemetryIdentity() === null) {
    return {
      enabled: config.enabled,
      configRevision: config.revision,
      productEnrollment,
      usedBytes: 0,
      maxBytes: TELEMETRY_LIMITS.maxTotalBytes,
      gaps: 0,
      profiles: TELEMETRY_PROFILE_IDS.map((profile) => ({
        profile,
        capturing: profileIsCapturing(config, profile),
        exporting: profileIsExporting(config, profile),
        paused: false,
        pausedReason: null,
        pending: 0,
        pendingBytes: 0,
        oldestPendingAgeMs: null,
        lastAcceptedAt: null,
        failing: false,
      })),
    };
  }

  return telemetryTransaction((d) => {
    const profiles: TelemetryProfileSummary[] = TELEMETRY_PROFILE_IDS.map((profile) => {
      const destination = getDestination(d, profile);
      const counts = deliveryCounts(d, profile);
      return {
        profile,
        capturing: profileIsCapturing(config, profile),
        exporting: profileIsExporting(config, profile),
        // The OPERATOR's pause, which is a configuration value, kept separate from the
        // daemon's own - `pausedReason` beside it. A panel has to be able to say "you paused
        // this" and "it stopped itself, and why" as different sentences.
        paused:
          profile === "user"
            ? config.user.paused
            : profile === "product"
              ? config.product.paused
              : false,
        pausedReason: destination.pausedReason,
        // Pending plus retrying: both are undelivered work an operator is waiting on, and a
        // figure that hid the retrying half would read as an empty queue during an outage -
        // exactly when somebody is looking at it.
        pending: counts.pending + counts.retrying,
        pendingBytes: counts.pendingBytes,
        oldestPendingAgeMs: counts.oldestPendingAt === null ? null : now - counts.oldestPendingAt,
        lastAcceptedAt: destination.lastAcceptedAt,
        // The FACT of a failure, never its text. The sanitized message is already bounded, but
        // this frame reaches every open dashboard on every recompose and the health route is
        // where a person who wants the reason goes.
        failing: destination.lastError !== null,
      };
    });
    return {
      enabled: config.enabled,
      configRevision: config.revision,
      productEnrollment,
      usedBytes: usedBytes(d),
      maxBytes: TELEMETRY_LIMITS.maxTotalBytes,
      gaps: listGaps(d).length,
      profiles,
    };
  });
}
