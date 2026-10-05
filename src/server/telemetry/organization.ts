/**
 * A recognized organization's managed telemetry lane: apply it, keep it in step, withdraw it.
 *
 * Runs at daemon start, before the telemetry cycle starts, and on Re-check. Every write goes
 * through `setTelemetryConfig` with the daemon's own actor, so revisions, destination
 * generations, consent epochs, the delta baseline and the export-shape reset all apply exactly
 * as they do to a person's edit. Each write is one transaction with the record it implies, so a
 * crash can never leave the record describing a configuration that was not stored.
 *
 * The pilot invariant: while an organization is active and its rollout is `pilot`, the product
 * destination is enabled if and only if this Mac joined the pilot. Every apply re-asserts it,
 * which is what keeps every path - first application, an upgrade, a Re-check, a restart after a
 * crash - from leaving a non-enrolled Mac sending to the organization's gateway.
 *
 * Design source: docs/plans/upstart-datadog-telemetry/phase-3-recognize-upstart.md.
 */
import { APP_CONFIG_ENTRIES } from "@shared/app-config-entries.ts";
import {
  TelemetryDestinationSchema,
  type TelemetryConfig,
  type TelemetryDestination,
} from "@shared/telemetry.ts";
import {
  TelemetryOrganizationRecordSchema,
  type TelemetryOrganizationRecord,
} from "@shared/organizations.ts";
import { deleteAppConfig, getAppConfig, hasAppConfigRow, setAppConfig } from "../db.ts";
import { ORGANIZATION_IDS } from "@shared/organizations.ts";
import {
  currentOrganization,
  defaultOrganizationDetectionDeps,
  detectOrganizationState,
  heldOrganization,
  publishOrganization,
  withdrawingOrganization,
  type DetectedOrganization,
  type OrganizationDetectionDeps,
} from "../environment/organization.ts";
import { ORGANIZATIONS, type OrganizationEntry } from "../environment/organizations.ts";
import { getTelemetryConfig, setTelemetryConfig } from "./config.ts";
import { telemetryTransaction } from "./store.ts";

const RECORD_ENTRY = APP_CONFIG_ENTRIES.telemetryOrganization;

/** What one apply did, for the log line and the tests. */
export type OrganizationApplyOutcome =
  | { kind: "unmanaged" }
  | { kind: "applied"; first: boolean; changed: boolean }
  | { kind: "withdrawn"; restored: "previous" | "cleared" }
  | { kind: "refused"; error: string }
  /** The enrollment could not be read, so nothing was applied or withdrawn. */
  | { kind: "indeterminate" };

/** The stored record, or null when there is none or it cannot be read by this build. */
export function telemetryOrganizationRecord(): TelemetryOrganizationRecord | null {
  const stored = storedRecord();
  return stored.kind === "readable" ? stored.record : null;
}

/**
 * The stored record, keeping "there is none" apart from "there is one this build cannot read".
 *
 * The two mean opposite things. No record is an unmanaged machine. An unreadable record - a
 * corrupted row, or one a newer build wrote - is proof the product destination WAS managed,
 * and with it the saved destination withdrawal would restore is lost. Collapsing the second
 * into the first is how a Mac leaves an organization with that organization's gateway still
 * configured and nothing locking it.
 */
type StoredRecord =
  | { kind: "none" }
  | { kind: "readable"; record: TelemetryOrganizationRecord }
  | { kind: "unreadable" };

function storedRecord(): StoredRecord {
  if (!hasAppConfigRow(RECORD_ENTRY)) return { kind: "none" };
  const stored = getAppConfig(RECORD_ENTRY);
  if (stored === undefined || stored === null) return { kind: "unreadable" };
  const parsed = TelemetryOrganizationRecordSchema.safeParse(stored);
  return parsed.success ? { kind: "readable", record: parsed.data } : { kind: "unreadable" };
}

/**
 * What withdrawal restores when the saved state is unknown: a product destination that is
 * cleared and off, which errs toward not sending. The person's own backend is not touched.
 */
const UNKNOWN_PREVIOUS: TelemetryOrganizationRecord["previous"] = {
  product: TelemetryDestinationSchema.parse({}),
  enabled: false,
};

/**
 * The product destination and master switch the organization's lane requires.
 *
 * Every field is written, not just the preset's: the destination is wholly managed, so
 * `paused` and `headerName` go back to their defaults too. The master switch is on while
 * enrolled, because the lane cannot send with collection off; otherwise it is what the person
 * had before first application, which the lock means nobody has changed since.
 */
function managedState(
  organization: DetectedOrganization,
  record: TelemetryOrganizationRecord,
): { enabled: boolean; product: TelemetryDestination } {
  const { preset } = organization.entry;
  const enrolled = record.pilotEnrolledAt !== null;
  return {
    enabled: enrolled ? true : record.previous.enabled,
    product: TelemetryDestinationSchema.parse({
      enabled: enrolled,
      endpoint: organization.endpoint,
      temporality: preset.temporality,
      networkGate: preset.networkGate,
      lateAfterMs: preset.lateAfterMs,
      exportShape: preset.exportShape,
    }),
  };
}

class ApplyRefused extends Error {}

/**
 * Store the record and the configuration it implies as one transaction.
 *
 * `setTelemetryConfig` nests inside as a savepoint. A refusal is thrown so the record write
 * rolls back with it: a record whose configuration was refused would describe a state that
 * was never stored.
 */
function storeManaged(
  organization: DetectedOrganization,
  record: TelemetryOrganizationRecord,
  now: number,
): boolean {
  return telemetryTransaction(() => {
    setAppConfig(RECORD_ENTRY, record);
    const applied = setTelemetryConfig(managedState(organization, record), now);
    if (!applied.ok) throw new ApplyRefused(applied.error);
    return applied.changed;
  });
}

/**
 * Bring this machine's telemetry into line with the organization that manages it, or with
 * none.
 *
 * - Detected, no record: first application. The whole prior product destination and the
 *   master switch are kept in the record, and the product destination becomes the preset,
 *   switched OFF whatever it was, in one transaction. No Mac is enrolled at first application.
 *   The endpoint change bumps the generation, which fences batches queued for the previous
 *   endpoint, and the switch-off drops them, so neither can be redirected to the gateway.
 * - Detected, record present: every preset field is written again and the pilot invariant is
 *   re-asserted. A write that changes nothing stores nothing and bumps nothing.
 * - Not detected, record present: the previous product destination and master switch are
 *   restored in one write, and the record is deleted.
 * - A record that exists but cannot be read is managed state whose saved destination is lost.
 *   Not detected, the product destination is cleared and switched off before the record goes;
 *   detected, it is re-applied with that cleared destination as what withdrawal will restore.
 *   Neither path can leave the gateway configured on a Mac nothing manages.
 */
export function applyOrganization(
  organization: DetectedOrganization | null,
  now = Date.now(),
): OrganizationApplyOutcome {
  const stored = storedRecord();
  const record = stored.kind === "readable" ? stored.record : null;

  if (organization === null) {
    if (stored.kind === "none") return { kind: "unmanaged" };
    if (stored.kind === "unreadable") return withdrawUnreadable(now);
    return withdraw(stored.record, now);
  }

  const first = record === null || record.organization !== organization.entry.id;
  const base: TelemetryOrganizationRecord =
    record !== null && !first
      ? record
      : {
          organization: organization.entry.id,
          presetVersion: organization.entry.presetVersion,
          previous:
            stored.kind === "unreadable"
              ? UNKNOWN_PREVIOUS
              : previousOf(record, getTelemetryConfig()),
          pilotEnrolledAt: null,
          enabledByDefault: false,
          noticeAcknowledgedAt: null,
          appliedAt: now,
        };
  // Every preset field is written on every apply, not only when `presetVersion` is newer. A
  // newer version is the case that has to rewrite them; writing them every time also repairs
  // a crash between two writes and follows a forced endpoint, and costs nothing when nothing
  // differs, because an identical configuration stores no change.
  const next: TelemetryOrganizationRecord = {
    ...base,
    presetVersion: organization.entry.presetVersion,
  };
  try {
    const changed = storeManaged(organization, next, now);
    return { kind: "applied", first, changed };
  } catch (error) {
    if (error instanceof ApplyRefused) return { kind: "refused", error: error.message };
    throw error;
  }
}

/**
 * What withdrawal will restore.
 *
 * The CURRENT configuration on a true first application. A record left by a different
 * organization keeps that record's `previous` instead: the current product destination is
 * that organization's preset, never the person's own.
 */
function previousOf(
  record: TelemetryOrganizationRecord | null,
  config: TelemetryConfig,
): TelemetryOrganizationRecord["previous"] {
  if (record !== null) return record.previous;
  return { product: config.product, enabled: config.enabled };
}

function withdraw(record: TelemetryOrganizationRecord, now: number): OrganizationApplyOutcome {
  return telemetryTransaction(() => {
    let restored: "previous" | "cleared" = "previous";
    const applied = setTelemetryConfig(
      { enabled: record.previous.enabled, product: record.previous.product },
      now,
    );
    if (!applied.ok) {
      // The destination that was there before no longer passes the transport rules - this
      // daemon's port moved onto it, say. Leaving the organization's preset in place on a Mac
      // that is no longer managed is the one outcome that must not happen, so the product
      // destination is cleared and switched off instead, which errs toward not sending.
      const cleared = setTelemetryConfig(
        { enabled: record.previous.enabled, product: TelemetryDestinationSchema.parse({}) },
        now,
      );
      if (!cleared.ok) return { kind: "refused", error: cleared.error } as const;
      restored = "cleared";
    }
    deleteAppConfig(RECORD_ENTRY);
    return { kind: "withdrawn", restored } as const;
  });
}

/**
 * Withdraw with an unreadable record: clear and switch off the product destination, which the
 * record proves was managed, then delete the record - in one transaction, so a refusal keeps
 * the record and the next start tries again. The master switch is left where it is: it also
 * governs local collection and the person's own backend, and with the product destination
 * cleared it cannot send anything to the gateway.
 */
function withdrawUnreadable(now: number): OrganizationApplyOutcome {
  return telemetryTransaction(() => {
    const cleared = setTelemetryConfig({ product: UNKNOWN_PREVIOUS.product }, now);
    if (!cleared.ok) return { kind: "refused", error: cleared.error } as const;
    deleteAppConfig(RECORD_ENTRY);
    return { kind: "withdrawn", restored: "cleared" } as const;
  });
}

/** Join or leave the pilot on this Mac. */
export type PilotEnrollmentResult =
  | { ok: true; changed: boolean }
  | { ok: false; status: 409; error: string };

export function setPilotEnrollment(enrolled: boolean, now = Date.now()): PilotEnrollmentResult {
  const organization = currentOrganization();
  if (organization === null) {
    return {
      ok: false,
      status: 409,
      error: "No organization manages telemetry on this Mac, so there is no pilot to join.",
    };
  }
  if (organization.withdrawing) {
    return {
      ok: false,
      status: 409,
      error: `${organization.entry.label} no longer manages this Mac, and removing its telemetry settings has not finished. Re-check to complete it.`,
    };
  }
  if (organization.entry.rollout !== "pilot") {
    return {
      ok: false,
      status: 409,
      error: `${organization.entry.label}'s telemetry is no longer in its pilot.`,
    };
  }
  // Apply first, so a record is guaranteed to exist and to describe this organization.
  const applied = applyOrganization(organization, now);
  if (applied.kind === "refused") return { ok: false, status: 409, error: applied.error };
  const record = telemetryOrganizationRecord();
  if (record === null) {
    return { ok: false, status: 409, error: "The organization record could not be read." };
  }
  const pilotEnrolledAt = enrolled ? (record.pilotEnrolledAt ?? now) : null;
  if (pilotEnrolledAt === record.pilotEnrolledAt) return { ok: true, changed: false };
  try {
    const changed = storeManaged(organization, { ...record, pilotEnrolledAt }, now);
    return { ok: true, changed };
  } catch (error) {
    if (error instanceof ApplyRefused) return { ok: false, status: 409, error: error.message };
    throw error;
  }
}

/**
 * The recheck in flight, or the last one to finish. Rechecks run one at a time, each after the
 * one before it, so two can never interleave a detection with the other's apply.
 */
let settling: Promise<unknown> = Promise.resolve();

/**
 * Detect again, then apply. What daemon start and Re-check both run.
 *
 * Starts synchronously - `settling` is replaced before this returns - so a caller that starts
 * a recheck has closed the settings window before its next line runs. The daemon relies on
 * that: it starts the startup recheck in the listening callback, before any request can be
 * read, and every telemetry settings route waits on `organizationSettled` first.
 */
export function recheckOrganization(
  deps?: OrganizationDetectionDeps,
  now = Date.now(),
): Promise<OrganizationApplyOutcome> {
  const run = settling.catch(() => {}).then(async (): Promise<OrganizationApplyOutcome> => {
    const state = await detectOrganizationState(deps ?? defaultOrganizationDetectionDeps());
    if (state.kind === "indeterminate") {
      // An unreadable answer is not an unenrollment. Change nothing, and keep the lock over
      // whatever is stored; the next start or Re-check reads again.
      publishOrganization(heldLock());
      return { kind: "indeterminate" };
    }
    const detected = state.kind === "matched" ? state.organization : null;
    let outcome: OrganizationApplyOutcome;
    try {
      outcome = applyOrganization(detected, now);
    } catch (error) {
      // A write that threw - a full disk, a locked database. Whatever is stored is still
      // stored, so the lock follows the store, not detection.
      publishOrganization(settledLock(detected));
      throw error;
    }
    publishOrganization(settledLock(detected));
    return outcome;
  });
  settling = run;
  return run;
}

/**
 * The lock to publish once an apply has run, succeeded or not.
 *
 * Detected: that organization. Not detected: unmanaged only once the record is gone. While
 * it remains - the withdrawal was refused or threw - the Mac stays locked as withdrawing,
 * named after the organization the record belongs to. If even the store cannot be asked, the
 * lock holds too: failing closed keeps a managed destination from becoming editable.
 */
function settledLock(detected: DetectedOrganization | null): DetectedOrganization | null {
  if (detected !== null) return detected;
  let recordRemains: boolean;
  try {
    recordRemains = hasAppConfigRow(RECORD_ENTRY);
  } catch {
    recordRemains = true;
  }
  if (!recordRemains) return null;
  return withdrawingOrganization(recordOrganization() ?? fallbackEntry());
}

/**
 * The lock to keep when the enrollment could not be read.
 *
 * The lock this daemon already holds, unchanged - forced endpoint, withdrawal state and all. A
 * daemon that holds none yet (an unreadable read at start) is locked if a managed record is
 * stored, named after its organization, and left unmanaged if none is: a Mac nothing was ever
 * applied to stays exactly as it was. If the store cannot be asked, the lock holds.
 */
function heldLock(): DetectedOrganization | null {
  const held = currentOrganization();
  if (held !== null) return held;
  let recordRemains: boolean;
  try {
    recordRemains = hasAppConfigRow(RECORD_ENTRY);
  } catch {
    recordRemains = true;
  }
  if (!recordRemains) return null;
  return heldOrganization(recordOrganization() ?? fallbackEntry());
}

/** The organization a stored record names, readable or not, when it names a known one. */
function recordOrganization(): OrganizationEntry | null {
  try {
    const raw = getAppConfig(RECORD_ENTRY) as { organization?: unknown } | undefined;
    const id = ORGANIZATION_IDS.find((candidate) => candidate === raw?.organization);
    return id === undefined ? null : ORGANIZATIONS[id];
  } catch {
    return null;
  }
}

/**
 * Who a record that names nobody belongs to: the organization this daemon last held the lock
 * for, else the first registered one - the only kind of organization that ever writes one.
 */
function fallbackEntry(): OrganizationEntry {
  return currentOrganization()?.entry ?? ORGANIZATIONS[ORGANIZATION_IDS[0]];
}

/**
 * Resolves once no recheck is in flight, whatever the last one's outcome.
 *
 * Without this, an Upstart Mac answers settings requests in the window between the daemon
 * listening and its startup detection finishing: no organization is known yet, so the panel
 * renders editable and a write is accepted. Detection is bounded (two seconds at most, one
 * `profiles` call on macOS, nothing elsewhere), so this delays an answer, never withholds one.
 */
export async function organizationSettled(): Promise<void> {
  for (;;) {
    const current = settling;
    await current.catch(() => {});
    // A recheck started while we waited is a newer answer; wait for that one too.
    if (current === settling) return;
  }
}

/** One line for the daemon log. Silent on an unmanaged machine, which is almost every one. */
export function describeOrganizationOutcome(outcome: OrganizationApplyOutcome): string | null {
  const organization = currentOrganization();
  switch (outcome.kind) {
    case "unmanaged":
      return null;
    case "indeterminate":
      return organization === null
        ? null
        : `[organization] could not read this Mac's device management enrollment; the telemetry settings ${organization.entry.label} manages are unchanged`;
    case "applied":
      return outcome.first
        ? `[organization] ${organization?.entry.label ?? "an organization"} manages telemetry on this Mac; its product destination is configured and off until pilot enrollment`
        : null;
    case "withdrawn":
      return outcome.restored === "previous"
        ? "[organization] no organization manages this Mac any more; the previous telemetry settings are restored"
        : "[organization] no organization manages this Mac any more; the previous product destination no longer validates, so it was cleared";
    case "refused":
      return `[organization] could not apply managed telemetry: ${outcome.error}`;
  }
}
