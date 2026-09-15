/**
 * The three things an operator can do to a telemetry queue that are not a setting, and the one
 * place a telemetry control action is recorded.
 *
 * Phase 1 gave the facility its meaning - what disabling means, what pausing means, what an
 * endpoint change costs a backlog. This module is Phase 2's other half: the operations that act
 * once on state the daemon already holds, and have no stored value to be a setting of.
 *
 *  - **retry** clears a daemon-initiated pause and brings every backed-off batch forward, so
 *    "Try again" means something on a destination that is an hour into its ceiling.
 *  - **purge** drops one profile's unsent work without touching the other profiles, the other
 *    audiences' queues, or anything outside telemetry.
 *  - **reset_identity** mints a new installation pseudonym, which invalidates every previously
 *    exported correlation at once - and therefore has to take the queues with it.
 *
 * All three are captured through the ordinary facade rather than logged separately: an
 * operator-initiated change to this facility is exactly the kind of fact it exists to record,
 * and a second logging path would be a second thing to keep private.
 */
import {
  TELEMETRY_PROFILE_IDS,
  type TelemetryOperation,
  type TelemetryOperationResult,
  type TelemetryProfileId,
} from "@shared/telemetry.ts";
import { TELEMETRY_CONTROL_EVENT } from "@shared/telemetry-catalog.ts";
import type { TelemetryOperationContext } from "@shared/telemetry-ingress.ts";
import { captureTelemetry } from "./capture.ts";
import { getTelemetryConfig, resetTelemetryIdentity } from "./config.ts";
import { newSpanId } from "./identity.ts";
import {
  getDestination,
  purgeProfileQueue,
  releaseBackoff,
  telemetryTransaction,
  updateDestination,
} from "./store.ts";

/**
 * Record that a control action was applied.
 *
 * Called AFTER the change, always, and the ordering carries a real consequence rather than
 * being tidy: turning collection ON is recorded, because capture has just become permitted;
 * turning it OFF is not, because it has just stopped being permitted and consent withdrawn is
 * not consent to keep recording the withdrawal. `captureTelemetry` returns `disabled` in that
 * second case and nothing is written.
 *
 * The actor comes from the request's operation context and carries its own basis with it, so a
 * record can say "a person did this in the app", "something claimed to" or "we do not know"
 * without any of the three being mistaken for the others.
 */
export function recordTelemetryControl(input: {
  action: "configure" | TelemetryOperation;
  profile: TelemetryProfileId | "all";
  outcome: "applied" | "refused";
  context: TelemetryOperationContext;
  now?: number;
}): void {
  captureTelemetry({
    event: TELEMETRY_CONTROL_EVENT,
    // Per invocation. A control action is a distinct operator operation every time, the same
    // reasoning the probe's identity follows - there is no idempotency here for a shared
    // identity to protect, and a shared one would silently swallow the second of two changes.
    source: {
      kind: "mission.telemetry",
      id: `control:${input.action}:${input.profile}:${input.now ?? Date.now()}:${newSpanId()}`,
      revision: 1,
    },
    actor: input.context.actor,
    facts: {
      action: input.action,
      profile: input.profile,
      outcome: input.outcome,
      actor_basis: input.context.actor.basis,
    },
    // Only when there is one. An absent operation id must stay absent rather than become the
    // string "null", which would be a ref that joins every unattributed action to every other.
    refs: input.context.operationId ? { operation_id: input.context.operationId } : {},
    now: input.now,
  });
}

/**
 * Apply one maintenance operation.
 *
 * Returns counts rather than throwing: like everything else in this facility, a telemetry
 * operation failing must not become an exception somewhere an operator cannot act on it. The
 * caller records the outcome; this function decides what happened.
 */
export function runTelemetryOperation(
  action: TelemetryOperation,
  profile?: TelemetryProfileId,
  now = Date.now(),
): TelemetryOperationResult {
  if (action === "reset_identity") return resetIdentity(now);
  // Guarded by the request schema, and again here: this module is called from tests and from
  // the route, and a missing profile must not silently become `local`.
  if (!profile) {
    return {
      action,
      profile: null,
      purged: 0,
      resumed: false,
      identity: null,
      detail: "This operation needs a destination.",
    };
  }
  return action === "purge" ? purge(profile, now) : retry(profile, now);
}

function retry(profile: TelemetryProfileId, now: number): TelemetryOperationResult {
  return telemetryTransaction((d) => {
    const before = getDestination(d, profile);
    const resumed = before.pausedReason !== null;
    // The pause and the recorded failure both clear. Leaving `lastError` behind would leave
    // the panel showing yesterday's reason beside a queue that is draining again.
    updateDestination(d, profile, { pausedReason: null, lastError: null }, now);
    const released = releaseBackoff(d, profile, now);
    return {
      action: "retry" as const,
      profile,
      purged: 0,
      resumed,
      identity: null,
      detail:
        released === 0 && !resumed
          ? "Nothing was waiting on a retry for this destination."
          : `${released} queued batch${released === 1 ? "" : "es"} will be attempted on the next cycle.`,
    };
  });
}

function purge(profile: TelemetryProfileId, now: number): TelemetryOperationResult {
  return telemetryTransaction((d) => {
    // `purgeProfileQueue` drops this profile's undelivered batches, its series and its
    // projection state - and nothing else. Sessions, tasks, workflows, usage and the OTHER
    // profiles' queues are untouched, which is the property consent withdrawal depends on and
    // which this operation reuses rather than reimplements.
    const purged = purgeProfileQueue(d, profile);
    // A purge is not a resume: a destination that paused itself on bad credentials still has
    // bad credentials, and clearing the reason here would hide that behind an empty queue.
    updateDestination(d, profile, { lastError: null }, now);
    return {
      action: "purge" as const,
      profile,
      purged,
      resumed: false,
      identity: null,
      detail:
        purged === 0
          ? "There was nothing queued for this destination."
          : `Dropped ${purged} batch${purged === 1 ? "" : "es"} that had not been delivered. Anything already accepted by a backend cannot be recalled.`,
    };
  });
}

function resetIdentity(now: number): TelemetryOperationResult {
  // Minted OUTSIDE the queue transaction, because it writes through `app_config` rather than
  // the telemetry tables and the two are separate stores with separate owners.
  const identity = resetTelemetryIdentity();
  const purged = telemetryTransaction((d) => {
    let total = 0;
    for (const profile of TELEMETRY_PROFILE_IDS) {
      // Every profile, including the ones that are off. A queued batch was built under the
      // OLD pseudonym and carries it in its resource; delivering it after a reset would tie the
      // new identity to the old one at the backend, which is the one thing a reset promises it
      // does not do. There is no way to rewrite them - the resource is part of the serialized
      // payload - so they go.
      total += purgeProfileQueue(d, profile);
      updateDestination(d, profile, { pausedReason: null, lastError: null }, now);
    }
    return total;
  });
  return {
    action: "reset_identity" as const,
    profile: null,
    purged,
    resumed: false,
    identity: { installationId: identity.installationId, epoch: identity.epoch },
    detail:
      `This installation now reports as a new pseudonym. ${purged} undelivered batch${purged === 1 ? "" : "es"} built under the previous one ` +
      "went with it; data a backend already accepted keeps the old identity and cannot be recalled.",
  };
}

/** Whether collection is on at all, for the routes that refuse an operation without it. */
export function telemetryCollectionEnabled(): boolean {
  return getTelemetryConfig().enabled;
}
