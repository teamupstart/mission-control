import type { OrganizationId, OrganizationRollout } from "@shared/organizations.ts";
import type { TelemetryDestination } from "@shared/telemetry.ts";

// The organizations Mission Control recognizes, and everything each one manages.
//
// This is the only place in the codebase that names one. Detection, the managed telemetry
// lane, the lock and the Settings block all read an entry from here, so adding an
// organization is one entry - and a machine that matches none of them behaves exactly as if
// this file did not exist.

/** The product destination fields an organization's preset owns. */
export type OrganizationTelemetryPreset = Pick<
  TelemetryDestination,
  "endpoint" | "temporality" | "networkGate" | "lateAfterMs" | "exportShape"
> & {
  /** `deployment.environment.name` on a recognized machine, unless the operator overrides it. */
  environment: string;
};

export interface OrganizationEntry {
  id: OrganizationId;
  label: string;
  /**
   * Device management server hostnames that identify this organization, matched exactly.
   *
   * Exact, never a suffix: a hosted MDM such as Jamf Cloud gives every customer a subdomain
   * of one shared domain, so anything looser than the tenant's own hostname matches other
   * companies' Macs.
   */
  mdmHosts: readonly string[];
  /** The sentence Settings shows for the matched host. */
  evidence: (host: string) => string;
  /** What the managed lane sends to, in a person's words. */
  destinationLabel: string;
  /** The network the lane's gateway is reachable from, in a person's words. */
  networkLabel: string;
  preset: OrganizationTelemetryPreset;
  /**
   * Bumped whenever `preset` changes. A recognized machine whose record names an older
   * version has every preset field written again.
   */
  presetVersion: number;
  rollout: OrganizationRollout;
}

export const ORGANIZATIONS: Readonly<Record<OrganizationId, OrganizationEntry>> = {
  upstart: {
    id: "upstart",
    label: "Upstart",
    mdmHosts: ["upstart.jamfcloud.com"],
    evidence: (host) => `This Mac is enrolled in Upstart's device management (${host}).`,
    destinationLabel: "Upstart's Datadog",
    networkLabel: "the Upstart network",
    preset: {
      endpoint: "https://corp-otel-staging-1.upstart.com",
      temporality: "delta",
      networkGate: "cloudflare-edge",
      // Datadog accepts a point up to one hour old. Anything later is counted as late.
      lateAfterMs: 3_600_000,
      exportShape: "datadog-lean",
      environment: "corp",
    },
    presetVersion: 2,
    rollout: "default-on",
  },
};
