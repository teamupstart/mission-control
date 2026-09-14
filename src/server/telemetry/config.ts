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
import {
  clearSecret,
  getDestination,
  getSecret,
  hasSecret,
  journalHead,
  purgeProfileQueue,
  putProjectionState,
  putSecret,
  telemetryTransaction,
  updateDestination,
} from "./store.ts";

const CONFIG_ENTRY = APP_CONFIG_ENTRIES.telemetry;
const IDENTITY_ENTRY = APP_CONFIG_ENTRIES.telemetryIdentity;

/**
 * Whether the public product audience can be enabled at all.
 *
 * Hard-coded unavailable, and deliberately not a setting. The public ingest service is
 * separately scoped in the approved design and does not exist: no enrollment, no
 * authentication, no quota, no retention policy. A build that let an operator switch it on
 * would be queueing data for an address that will never answer while telling them they were
 * sharing - which is worse than not offering it.
 */
export function telemetryProductEnrollment(): TelemetryProductEnrollment {
  return productIngestDescriptor === null ? "unavailable" : "available";
}

/**
 * The product ingest descriptor. `null` in every shipped build, and there is no configuration,
 * environment variable or API that can change that - only the function below, which refuses
 * outside the test runner.
 *
 * The seam exists because the two audiences must be provably INDEPENDENT - separate queues,
 * separate identities, separate consent epochs, separate failure handling - and a property
 * about two destinations cannot be demonstrated against one. The approved plan calls for
 * exactly this: product policy verified against an isolated local receiver, with enrollment
 * reported honestly to real operators.
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
  const stored = getAppConfig(IDENTITY_ENTRY);
  if (stored && typeof stored === "object" && typeof stored.installationId === "string") {
    return stored as TelemetryIdentity;
  }
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
  const stored = getAppConfig(IDENTITY_ENTRY);
  if (stored && typeof stored === "object" && typeof stored.installationId === "string") {
    return stored as TelemetryIdentity;
  }
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
  if (profile === "product" && telemetryProductEnrollment() === "unavailable") return false;
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

export type TelemetryConfigRefusal = { ok: false; error: string };
export type TelemetryConfigApplied = { ok: true; config: TelemetryConfig };

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
  const next = TelemetryConfigSchema.parse({
    ...previous,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.user ? { user: { ...previous.user, ...patch.user } } : {}),
    ...(patch.product ? { product: { ...previous.product, ...patch.product } } : {}),
  });

  if (next.product.enabled && telemetryProductEnrollment() === "unavailable") {
    return {
      ok: false,
      error:
        "Product analytics has no ingest service in this build. Enabling it would queue data for an endpoint that cannot exist.",
    };
  }

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

  return telemetryTransaction((d) => {
    if (patch.userCredential !== undefined) {
      if (patch.userCredential.length > 0) {
        putSecret(d, "user", next.user.headerName, patch.userCredential, now);
      } else {
        clearSecret(d, "user");
      }
    } else if (patch.user?.headerName && getSecret(d, "user")) {
      // Renaming the header must move the existing secret, not orphan it under the old name.
      const existing = getSecret(d, "user");
      if (existing) putSecret(d, "user", next.user.headerName, existing.headerValue, now);
    }

    setAppConfig(CONFIG_ENTRY, next);

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

    return { ok: true, config: next } satisfies TelemetryConfigApplied;
  });
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
    productEnrollment: telemetryProductEnrollment(),
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
