/**
 * The browser-safe half of organization recognition: which organizations Mission Control can
 * recognize, the durable record of what it did on a recognized machine, and the wire shape
 * Settings > Telemetry renders.
 *
 * What an organization IS - its device management hosts, its telemetry preset, its rollout -
 * lives in exactly one server file, `src/server/environment/organizations.ts`. Nothing here
 * names a host, an endpoint or an organization's own words, so a browser bundle built from
 * this file says nothing about any one company.
 *
 * Design source: docs/plans/upstart-datadog-telemetry/phase-3-recognize-upstart.md.
 */
import { z } from "zod";
import { TelemetryDestinationSchema, type TelemetryExportShapeId } from "./telemetry.ts";

/**
 * The organizations Mission Control can recognize.
 *
 * APPEND-ONLY. An id is persisted in the `telemetry.organization` record and read back by
 * exact value, so a value may be added at the end and never renamed, reordered or removed.
 */
export const ORGANIZATION_IDS = ["upstart"] as const;
export type OrganizationId = (typeof ORGANIZATION_IDS)[number];

/**
 * How far an organization's managed telemetry lane has rolled out.
 *
 * `pilot`: the lane is configured on every recognized Mac and sends only from Macs whose
 * person enrolled through `POST /api/telemetry/organization/pilot`. Append-only; the
 * default-on stage is a later phase's addition.
 */
export const ORGANIZATION_ROLLOUTS = ["pilot"] as const;
export type OrganizationRollout = (typeof ORGANIZATION_ROLLOUTS)[number];

/**
 * What Mission Control did to this machine's telemetry when it recognized an organization.
 *
 * Per machine and never restored from a settings snapshot, for the same reason the telemetry
 * config itself is not: it describes this Mac's enrollment, and on another installation it
 * would restore a product destination that was never there.
 */
export const TelemetryOrganizationRecordSchema = z.object({
  organization: z.enum(ORGANIZATION_IDS),
  /** The preset revision last written into the product destination. */
  presetVersion: z.number().int().min(1),
  /**
   * The product destination and master switch exactly as they were before first application,
   * so withdrawal can put them back - including a product switch that was on.
   */
  previous: z.object({
    product: TelemetryDestinationSchema,
    enabled: z.boolean(),
  }),
  /** When this Mac joined the pilot, or null. Product analytics sends exactly when this is set. */
  pilotEnrolledAt: z.number().int().nullable().default(null),
  /** Whether the lane is on because the rollout turned it on. Always false during `pilot`. */
  enabledByDefault: z.boolean().default(false),
  /** When the person acknowledged the default-on notice. Unused during `pilot`. */
  noticeAcknowledgedAt: z.number().int().nullable().default(null),
  appliedAt: z.number().int(),
});
export type TelemetryOrganizationRecord = z.infer<typeof TelemetryOrganizationRecordSchema>;

/** Join or leave an organization's telemetry pilot on this Mac. */
export const TelemetryOrganizationPilotRequestSchema = z
  .object({ enrolled: z.boolean() })
  .strict();
export type TelemetryOrganizationPilotRequest = z.infer<
  typeof TelemetryOrganizationPilotRequestSchema
>;

/**
 * A recognized organization, as Settings > Telemetry renders it.
 *
 * Present only while an organization is detected or validly forced. Every string an
 * organization contributes arrives here from the daemon, so the panel prints them rather than
 * knowing any of them.
 */
export interface TelemetryOrganizationStatus {
  id: OrganizationId;
  /** The organization's own name, e.g. for "Managed by …". */
  label: string;
  /** One sentence naming the fact that recognized this machine. */
  evidence: string;
  /** What the managed lane sends to, in a person's words. */
  destinationLabel: string;
  /** The network the lane needs, in a person's words, for the waiting state. */
  networkLabel: string;
  rollout: OrganizationRollout;
  /** Always true: a recognized organization's telemetry settings are view-only. */
  managed: true;
  pilotEnrolled: boolean;
  /** What the product destination is configured with right now, read back from the store. */
  effective: {
    destination: "product";
    endpoint: string;
    temporality: "cumulative" | "delta";
    exportShape: TelemetryExportShapeId;
    networkGate: "none" | "cloudflare-edge";
    lateAfterMs: number | null;
    environment: string;
  };
}

/** The refusal every person-facing telemetry settings write answers while managed. */
export function managedTelemetryRefusal(
  id: OrganizationId,
  label: string,
): { error: string; managedBy: OrganizationId } {
  return { error: `Telemetry settings on this Mac are managed by ${label}`, managedBy: id };
}
