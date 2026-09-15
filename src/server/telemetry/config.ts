/**
 * The telemetry control surface: consent, endpoints, credentials, identity and the per-profile
 * fences everything downstream reads.
 *
 * Phase 2 owns the Settings UX; this module owns the MEANING those controls have, because the
 * durable pipeline needs them from its first commit. The distinctions it keeps are the ones
 * the design says must never blur: disabling is not pausing, a product opt-in is not a user
 * opt-in, and an endpoint change is not a way to redirect a queue somebody else built.
 */
import {
  TELEMETRY_PROFILE_IDS,
  TelemetryConfigSchema,
  type TelemetryConfig,
  type TelemetryConfigPatch,
  type TelemetryDestination,
  type TelemetryProductEnrollment,
  type TelemetryProfileId,
  type TelemetryStatus,
} from "@shared/telemetry.ts";
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import { getAppConfig, setAppConfig } from "../db.ts";
import { PORT } from "../config.ts";
import { digest } from "./identity.ts";
import { isLoopbackHost, validateEndpoint } from "./endpoint.ts";
import { registeredProjections } from "./registration.ts";
import { noteTelemetryCollectionChanged } from "./retention.ts";
import { resetSessionTelemetryObservations } from "./sessions.ts";
import {
  clearSecret,
  getDestination,
  getSecret,
  hasSecret,
  journalHead,
  purgeProfileQueue,
  putProjectionState,
  putSecret,
  retirePrObservationWindows,
  telemetryTransaction,
  updateDestination,
} from "./store.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.telemetry;
const IDENTITY_ENTRY = APP_CONFIG_ENTRIES.telemetryIdentity;

/**
 * Whether the minimized product audience can be enabled.
 *
 * Two things are being kept apart here, and conflating them was this facility's first mistake.
 *
 * **A hosted public analytics service** is separately scoped in the approved design and does not
 * exist: no enrollment, no authentication, no quota, no retention policy. This build ships no
 * endpoint for one, invents no hosting account, and enables no public sharing by default. That
 * has not changed and is not what this function decides.
 *
 * **The product EXPORT PROFILE** is a different thing: a second, independent destination whose
 * audience policy is narrower than the operator's own. It carries only the facts declared
 * `AUDIENCE_ALL` - diagnostics that mean something off this machine - and excludes everything
 * marked operator-only, which is what makes it "product" rather than a second copy of the
 * personal stream. An organization running Mission Control internally has a real use for that,
 * and nothing about it requires a service we host.
 *
 * So enrollment is a fact about whether there is somewhere to send it: available once the
 * operator has configured a product endpoint of their own, unavailable while there is none. The
 * original rule - that this cannot be switched on with nothing behind it - is preserved exactly,
 * because an empty endpoint still reports unavailable and the write is still refused. What
 * changed is that an operator who runs a collector is no longer refused along with it.
 */
export function telemetryProductEnrollment(
  config: TelemetryConfig = getTelemetryConfig(),
): TelemetryProductEnrollment {
  if (productIngestDescriptor !== null) return "available";
  return config.product.endpoint.trim().length > 0 ? "available" : "unavailable";
}

/**
 * An isolated local product receiver, installed by tests.
 *
 * Kept after the enrollment rule above stopped depending on it, because it still buys the one
 * thing configuration cannot: it makes the product audience available WITHOUT an endpoint, so a
 * test can demonstrate audience independence - separate queues, identities, consent epochs and
 * failure handling - without also asserting the endpoint rules in the same breath.
 */
let productIngestDescriptor: string | null = null;

/**
 * Install an isolated local product receiver, for tests only.
 *
 * Refuses outside the Node test runner rather than merely discouraging it. A seam that would
 * turn on real public sharing if someone set the wrong variable is not a test seam, it is a
 * defect waiting for a typo - so the guard is a throw, not a warning, and the signal it reads
 * is one no production launch carries.
 */
export function installProductIngestForTesting(descriptor: string | null): void {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error("the product ingest descriptor is a test-only seam");
  }
  productIngestDescriptor = descriptor;
}

/** The stored configuration with schema defaults applied. Every default is off. */
export function getTelemetryConfig(): TelemetryConfig {
  return TelemetryConfigSchema.parse(getAppConfig(CONFIG_ENTRY) ?? {});
}

/**
 * The stored identity, or null when there is nothing usable there.
 *
 * Both fields are checked, not just the id. A row written by a build that lacked `epoch`, or
 * one hand-edited, would otherwise flow through as `epoch: undefined` and be digested into
 * every profile salt and stamped on every resource as the string "undefined" - a silent,
 * permanent corruption of this installation's exported identity.
 */
function storedIdentity(): TelemetryIdentity | null {
  const stored = getAppConfig(IDENTITY_ENTRY);
  if (
    stored &&
    typeof stored === "object" &&
    typeof stored.installationId === "string" &&
    stored.installationId.length > 0 &&
    Number.isSafeInteger(stored.epoch) &&
    stored.epoch >= 1
  ) {
    return stored as TelemetryIdentity;
  }
  return null;
}

export interface TelemetryIdentity {
  /** A local random seed. Not an account, not a device fingerprint, not a person. */
  installationId: string;
  /** Bumped by a reset. A new epoch is a new installation identity to every destination. */
  epoch: number;
}

/**
 * This installation's pseudonym, minted on first read.
 *
 * Supports repeat-use and within-installation comparison, and nothing else: there is no
 * account lookup, no cross-device join and no fingerprint input. A reset mints a new one, which
 * legitimately appears downstream as a new installation - and that scope is reported rather
 * than hidden.
 */
export function telemetryIdentity(): TelemetryIdentity {
  const stored = storedIdentity();
  if (stored) return stored;
  const minted: TelemetryIdentity = {
    installationId: digest([Date.now(), Math.random(), process.pid]).slice(0, 24),
    epoch: 1,
  };
  setAppConfig(IDENTITY_ENTRY, minted);
  return minted;
}

/**
 * The identity if one exists, without minting one.
 *
 * The health view uses this rather than `telemetryIdentity`. An installation that has never
 * opted in must leave no telemetry trace at all, and a status read that quietly created a
 * pseudonym would break that on the very first dashboard poll.
 */
export function peekTelemetryIdentity(): TelemetryIdentity | null {
  const stored = storedIdentity();
  if (stored) return stored;
  return null;
}

/** Mint a new installation identity epoch. Runtime session and task identity are untouched. */
export function resetTelemetryIdentity(): TelemetryIdentity {
  const previous = telemetryIdentity();
  const next: TelemetryIdentity = {
    installationId: digest([Date.now(), Math.random(), previous.installationId]).slice(0, 24),
    epoch: previous.epoch + 1,
  };
  setAppConfig(IDENTITY_ENTRY, next);
  return next;
}

/**
 * The per-profile correlation salt.
 *
 * Different for every profile, which is what makes the same session's exported id unjoinable
 * across audiences, and derived from the installation identity so a reset invalidates every
 * previously exported correlation at once.
 */
export function profileSalt(profile: TelemetryProfileId): string {
  const identity = telemetryIdentity();
  return digest([identity.installationId, identity.epoch, profile]);
}

function destinationFor(config: TelemetryConfig, profile: TelemetryProfileId): TelemetryDestination | null {
  if (profile === "user") return config.user;
  if (profile === "product") return config.product;
  return null;
}

/** Whether this profile may have facts captured for it right now. */
export function profileIsCapturing(config: TelemetryConfig, profile: TelemetryProfileId): boolean {
  if (!config.enabled) return false;
  // `local` has no endpoint by definition: collection on with nothing configured is exactly
  // what local-only means, and it is the state the walking slice starts in.
  if (profile === "local") return true;
  // Against THIS config, not the stored one. The caller may be evaluating a patch that has not
  // been written yet, and reading the store here would answer about the wrong configuration.
  if (profile === "product" && telemetryProductEnrollment(config) === "unavailable") return false;
  return destinationFor(config, profile)?.enabled === true;
}

/**
 * Whether this profile accumulates EXPORT BATCHES.
 *
 * Note what is deliberately NOT here: `paused`. Pausing stops sending and keeps the backlog,
 * so a paused destination still builds batches and drains them when it resumes. Disabling is
 * the one that stops capture, and it drains nothing.
 */
export function profileProducesBatches(config: TelemetryConfig, profile: TelemetryProfileId): boolean {
  if (!profileIsCapturing(config, profile)) return false;
  const destination = destinationFor(config, profile);
  return destination !== null && destination.endpoint.trim().length > 0;
}

/** Whether this profile may have a request sent for it right now. */
export function profileIsExporting(config: TelemetryConfig, profile: TelemetryProfileId): boolean {
  if (!profileProducesBatches(config, profile)) return false;
  return destinationFor(config, profile)?.paused !== true;
}

/** Every profile eligible for capture, in stable order. */
export function capturingProfiles(config: TelemetryConfig): TelemetryProfileId[] {
  return TELEMETRY_PROFILE_IDS.filter((p) => profileIsCapturing(config, p));
}

export type TelemetryConfigRefusal = { ok: false; error: string; conflict?: true };
export type TelemetryConfigApplied = { ok: true; config: TelemetryConfig; changed: boolean };

/**
 * Apply a patch, and take every consent and endpoint consequence with it, in one transaction.
 *
 * The consequences are the point. A profile that just turned on gets a new policy epoch so it
 * starts a fresh metric baseline instead of inheriting the operator's cumulative totals; a
 * changed endpoint gets a new destination generation so batches built for the old one cannot
 * silently follow; and a profile that just turned off has its unsent queue and projections
 * purged, because consent withdrawn is not consent to keep the backlog.
 */
export function setTelemetryConfig(
  patch: TelemetryConfigPatch,
  now = Date.now(),
): TelemetryConfigApplied | TelemetryConfigRefusal {
  const previous = getTelemetryConfig();

  // The concurrency guard, BEFORE any validation or write. Two Settings tabs on one daemon is
  // ordinary - a second window, a phone - and consent is the setting where the loser of a
  // last-writer-wins race is somebody who believes they turned sharing off. A caller that does
  // not supply a revision keeps Phase 1's behavior exactly.
  if (patch.ifRevision !== undefined && patch.ifRevision !== previous.revision) {
    return {
      ok: false,
      conflict: true,
      error:
        "These telemetry settings changed somewhere else while this form was open. Reload the panel and make the change again.",
    };
  }

  const next = TelemetryConfigSchema.parse({
    ...previous,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.user ? { user: { ...previous.user, ...patch.user } } : {}),
    ...(patch.product ? { product: { ...previous.product, ...patch.product } } : {}),
  });

  // Asking to switch product sharing ON with nowhere to send it is refused, and the refusal is
  // keyed on the PATCH rather than on the resulting state: this is the operator explicitly
  // asking for something that cannot be honoured, and answering it silently would be worse than
  // the error. Evaluated against `next`, so one write may supply the endpoint and flip the
  // switch as a unit - against the stored config that write would refuse itself, because the
  // address it is in the middle of saving is not visible yet.
  if (patch.product?.enabled === true && telemetryProductEnrollment(next) === "unavailable") {
    return {
      ok: false,
      error:
        "Product analytics has no ingest service configured. Mission Control does not run a public analytics service, so this audience needs the address of a collector you run before it can be switched on.",
    };
  }

  // Clearing the address is a WITHDRAWAL, not a half-configured state, and the switch goes with
  // it. Two worse alternatives were available and both were rejected: refusing the write leaves
  // an operator who emptied the field staring at an error telling them to fill in the field,
  // and storing `enabled: true` with no address leaves a switch reading "on" over a destination
  // that is not sending - which would silently resume sharing the moment an address was typed
  // back in. Forcing it off is the only one of the three where the stored state and the screen
  // agree, and it errs toward not sharing.
  if (next.product.endpoint.trim().length === 0) next.product.enabled = false;

  // Validate against the credential that WILL be in place after this patch, not the one that
  // is now: turning HTTPS off in the same write that adds a token has to be refused as a unit.
  const credentialAfter =
    patch.userCredential === undefined
      ? telemetryTransaction((d) => hasSecret(d, "user"))
      : patch.userCredential.length > 0;
  // Both destinations, under the same rules. Sharing one contract is the point: a rule
  // enforced on one audience and not the other is a rule an operator can route around.
  for (const [profile, destination] of [
    ["user", next.user],
    ["product", next.product],
  ] as const) {
    if (destination.endpoint.trim().length === 0) continue;
    const check = validateEndpoint(destination.endpoint, {
      hasCredential: profile === "user" ? credentialAfter : false,
    });
    if (!check.ok) return { ok: false, error: check.detail };
    if (targetsThisDaemon(destination.endpoint)) {
      return {
        ok: false,
        error:
          "That is this Mission Control daemon's own address. Its /v1/metrics receiver is the Claude Code cost ingest, and exporting into it would feed telemetry back into the cost ledger.",
      };
    }
  }

  const applied = telemetryTransaction((d) => {
    // Did the STORED credential actually move? A PUT that echoes the same secret back - which
    // is what a form re-submit does - must not count as a change, or a second tab's open edit
    // is invalidated by somebody pressing Save twice.
    let credentialChanged = false;
    if (patch.userCredential !== undefined) {
      const existing = getSecret(d, "user");
      if (patch.userCredential.length > 0) {
        credentialChanged =
          existing?.headerValue !== patch.userCredential ||
          existing?.headerName !== next.user.headerName;
        putSecret(d, "user", next.user.headerName, patch.userCredential, now);
      } else {
        credentialChanged = existing !== null;
        clearSecret(d, "user");
      }
    } else if (patch.user?.headerName && getSecret(d, "user")) {
      // Renaming the header must move the existing secret, not orphan it under the old name.
      const existing = getSecret(d, "user");
      if (existing) {
        credentialChanged = existing.headerName !== next.user.headerName;
        putSecret(d, "user", next.user.headerName, existing.headerValue, now);
      }
    }

    // The revision moves only on a real change, so a duplicate save is idempotent all the way
    // down: same stored value, same revision, no generation bump, no epoch bump, and any other
    // tab's in-flight edit still applies. Compared on the configuration WITHOUT the revision
    // itself, which would otherwise always differ from what we are about to write.
    const changed =
      credentialChanged ||
      JSON.stringify({ ...previous, revision: 0 }) !== JSON.stringify({ ...next, revision: 0 });
    if (changed) next.revision = previous.revision + 1;

    setAppConfig(CONFIG_ENTRY, next);

    // Collection starting or stopping mid-run is a run boundary for the unclean-shutdown
    // detector, exactly as process start and shutdown are. Arming it only at boot meant a
    // daemon that was told to start collecting through the API never armed it at all.
    if (previous.enabled !== next.enabled) {
      noteTelemetryCollectionChanged(next.enabled);
      // In the consent transaction: neither a late merge nor a pending association from
      // the old window may be captured after collection resumes. Journal facts stay intact.
      retirePrObservationWindows(d);
    }

    for (const profile of TELEMETRY_PROFILE_IDS) {
      const wasCapturing = profileIsCapturing(previous, profile);
      const isCapturing = profileIsCapturing(next, profile);
      const destination = getDestination(d, profile);
      const endpointDigest = digest(destinationFor(next, profile)?.endpoint ?? "");

      if (!wasCapturing && isCapturing) {
        // A new opt-in starts a new baseline. Runs already in progress stay visible as
        // pre-existing observations because their journal rows carry the epoch they were
        // captured under, not this one.
        updateDestination(
          d,
          profile,
          {
            policyEpoch: destination.policyEpoch + 1,
            endpointDigest,
            pausedReason: null,
            lastError: null,
          },
          now,
        );
        // And the watermark, taken HERE rather than at the first projection pass. The moment
        // of consent is the only correct place for it: seeding it later would either skip the
        // first fact captured after opting in, or - if the journal had grown in between - hand
        // the new audience history it was never consented to. Both have been written by
        // accident; this line is where the difference is decided.
        const head = journalHead(d);
        for (const projection of registeredProjections()) {
          putProjectionState(
            d,
            projection.id,
            profile,
            {
              stateVersion: projection.stateVersion,
              consumedSeq: head,
              state: projection.initialState(),
            },
            now,
          );
        }
        continue;
      }

      if (wasCapturing && !isCapturing) {
        // Withdrawal. Unsent batches and this profile's projections go; already accepted data
        // at a remote backend cannot be recalled and is not pretended otherwise.
        purgeProfileQueue(d, profile);
        updateDestination(d, profile, { endpointDigest, pausedReason: null, lastError: null }, now);
        continue;
      }

      if (endpointDigest !== destination.endpointDigest) {
        // A new destination generation. Batches built for the previous endpoint keep their own
        // generation and are refused by the sender rather than redirected.
        updateDestination(
          d,
          profile,
          { generation: destination.generation + 1, endpointDigest, pausedReason: null, lastError: null },
          now,
        );
      }
    }

    return { ok: true, config: next, changed } satisfies TelemetryConfigApplied;
  });
  // Only after the consent write commits. Live sessions are first observed again on their
  // next publication; neither turns nor launch intents may bridge a collection gap.
  if (previous.enabled !== next.enabled) resetSessionTelemetryObservations();
  return applied;
}

/** Whether the operator has stored a credential for their own backend. Never the value. */
export function userCredentialConfigured(): boolean {
  return telemetryTransaction((d) => hasSecret(d, "user"));
}

/**
 * The config route's answer: stored intent plus the two things intent cannot tell you.
 *
 * Whether a credential EXISTS is reported; its value is not, and there is no read path that
 * would return one. Whether the saved endpoint still satisfies the transport rules is reported
 * too, because a stored value can become invalid - a credential added later turns a working
 * plaintext remote endpoint into a refused one, and a panel showing only intent would be
 * confidently wrong about it.
 */
export function telemetryStatus(): TelemetryStatus {
  const config = getTelemetryConfig();
  const hasCredential = userCredentialConfigured();
  const endpoint =
    config.user.endpoint.trim().length === 0
      ? null
      : validateEndpoint(config.user.endpoint, { hasCredential });
  return {
    config,
    productEnrollment: telemetryProductEnrollment(config),
    userCredentialConfigured: hasCredential,
    endpoint: endpoint
      ? { ok: endpoint.ok, detail: endpoint.detail, warning: endpoint.warning }
      : null,
  };
}

/**
 * Whether an endpoint points back at this daemon.
 *
 * Mission Control already serves `/v1/metrics` - it is the inbound Claude Code cost receiver,
 * with its own HTTP/JSON contract and its own ledger. Exporting general telemetry into it
 * would mix two unrelated facilities and, worse, feed the exporter's own output back in as
 * agent cost. The two stay independent, and this is where that is enforced.
 */
export function targetsThisDaemon(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
    return isLoopbackHost(url.hostname) && port === String(PORT);
  } catch {
    return false;
  }
}
