import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, isAbsolute } from "node:path";

import { ORGANIZATION_IDS } from "@shared/organizations.ts";
import { isLoopbackHost } from "@shared/telemetry-endpoint.ts";
import { stateDir } from "../../shared/harness-runtime.mjs";
import { run } from "../util/exec.ts";
import { readMdmEnrollment } from "./macos.ts";
import { ORGANIZATIONS, type OrganizationEntry } from "./organizations.ts";

// Which organization, if any, manages this machine.
//
// The rule is the approved uniqueness contract, and every part of it is there to keep another
// company's Mac from matching:
//
//   1. macOS reports `MDM enrollment: Yes` - this Mac is enrolled now, not formerly.
//   2. The `MDM server:` line of that SAME answer is an `https` URL with no userinfo whose
//      hostname, lowercased and without a trailing dot, is exactly one of an entry's
//      `mdmHosts`. No suffix, substring, vendor or app matching.
//
// The server URL comes from nowhere else. In particular Jamf's own preference file is never
// read: it outlives an unenrollment, so a Mac that left one organization and joined another
// could still name the first. A missing `MDM server:` line therefore means no organization.
//
// Detection runs only on macOS, only in a launch mode that serves a person, and never under a
// test runner or from a state home inside the temp dir - so neither the suite nor a fixture
// daemon can become managed by accident. `MISSION_ORGANIZATION` is the diagnostic override.

/** How the daemon was launched. Mirrors `DaemonLaunchMode` without importing telemetry. */
export type OrganizationLaunchMode = "desktop" | "daemon" | "dev";

export interface OrganizationDetectionDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  launchMode: OrganizationLaunchMode;
  /** This daemon's state home, as configured. Resolved through `realpath` by the guard. */
  stateHome: string;
  tmpdir: string;
  realpath: (path: string) => Promise<string>;
  run: typeof run;
  /** Where a refused override is reported. */
  warn: (message: string) => void;
}

/** A recognized organization and what recognized it. */
export interface DetectedOrganization {
  entry: OrganizationEntry;
  evidence: string;
  /** The endpoint the managed lane uses: the preset's, or a forced loopback replacement. */
  endpoint: string;
  /** True when `MISSION_ORGANIZATION` forced this rather than the machine matching. */
  forced: boolean;
  /**
   * True when the Mac is no longer recognized but its managed record has not been withdrawn
   * yet - the write failed. The lock stays on and Product analytics export is suspended until
   * a later start or Re-check completes the withdrawal. See `withdrawingOrganization`.
   */
  withdrawing?: boolean;
}

/**
 * The lock a Mac keeps while its withdrawal has not been written.
 *
 * Detection answering "not managed" is not the same as this Mac being unmanaged: until the
 * stored organization record is gone, the Product analytics destination may still point at
 * the organization's gateway. Publishing "unmanaged" in that state would unlock settings
 * over a destination nobody can see is managed, so the lock holds instead, naming the
 * organization the record belongs to.
 */
export function withdrawingOrganization(entry: OrganizationEntry): DetectedOrganization {
  return {
    entry,
    evidence: `This Mac is no longer recognized as managed by ${entry.label}, but removing ${entry.label}'s telemetry settings has not finished. They stay managed, and nothing is sent to ${entry.destinationLabel}, until Re-check or the next start completes it.`,
    endpoint: entry.preset.endpoint,
    forced: false,
    withdrawing: true,
  };
}

/**
 * Whether this run is one detection may count for.
 *
 * Each guard refuses on its own. A test runner marker is enough, a temp-dir state home is
 * enough, and so is a dev launch: none of those is a person's installation of the app.
 */
export async function detectionPermitted(deps: OrganizationDetectionDeps): Promise<boolean> {
  if (deps.launchMode !== "desktop" && deps.launchMode !== "daemon") return false;
  if (deps.env.NODE_TEST_CONTEXT !== undefined) return false;
  if (deps.env.MISSION_TEST_STATE !== undefined) return false;
  // Through `realpath` on both sides: on macOS the temp dir is itself a symlink
  // (`/var/folders/…` is `/private/var/folders/…`), and a home spelled either way must be
  // recognized. A home that cannot be resolved is refused - this guard fails closed.
  let home: string;
  let temp: string;
  try {
    home = await deps.realpath(deps.stateHome);
    temp = await deps.realpath(deps.tmpdir);
  } catch {
    return false;
  }
  return !isInside(home, temp);
}

function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The registered entry whose `mdmHosts` contains this URL's host, by the exact rule above. */
export function organizationForMdmServer(
  serverUrl: string,
): { entry: OrganizationEntry; host: string } | null {
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  for (const id of ORGANIZATION_IDS) {
    const entry = ORGANIZATIONS[id];
    if (entry.mdmHosts.includes(host)) return { entry, host };
  }
  return null;
}

/**
 * Which organization manages this machine, or null.
 *
 * Never throws. Every failure - another platform, a refused guard, an unreadable or
 * unrecognized `profiles` answer - is null, because null is the unmanaged machine's state and
 * the only safe one to fall into.
 */
export async function detectOrganization(
  deps: OrganizationDetectionDeps,
): Promise<DetectedOrganization | null> {
  const state = await detectOrganizationState(deps);
  return state.kind === "matched" ? state.organization : null;
}

/**
 * What detection learned, keeping "this Mac is not managed" apart from "this Mac's enrollment
 * could not be read".
 *
 * `detectOrganization` folds both into null, which is right for a first decision - an
 * unreadable answer must never manage a Mac. It is wrong for a Mac that is already managed: a
 * `profiles` timeout or failed exit there says nothing about the enrollment, and treating it as
 * unenrollment would withdraw the managed settings and unlock them on a Mac still enrolled.
 *
 * - `matched`: the exact-tenant rule matched, or a valid force applies.
 * - `unmatched`: a definite answer - the `none` override, another platform, a refused guard, or
 *   a well-formed `profiles` answer that does not match.
 * - `indeterminate`: `profiles` could not be read. Nothing should change.
 */
export type OrganizationDetectionState =
  | { kind: "matched"; organization: DetectedOrganization }
  | { kind: "unmatched" }
  | { kind: "indeterminate" };

export async function detectOrganizationState(
  deps: OrganizationDetectionDeps,
): Promise<OrganizationDetectionState> {
  const override = envValue(deps.env, "ORGANIZATION")?.trim().toLowerCase();
  if (override === "none") return { kind: "unmatched" };
  if (override !== undefined && override.length > 0) {
    const forced = forcedOrganization(override, deps);
    if (forced) return { kind: "matched", organization: forced };
  }

  if (deps.platform !== "darwin") return { kind: "unmatched" };
  if (!(await detectionPermitted(deps))) return { kind: "unmatched" };

  const enrollment = await readMdmEnrollment({ run: deps.run });
  if (enrollment === null) return { kind: "indeterminate" };
  if (!enrollment.enrolled || enrollment.serverUrl === null) return { kind: "unmatched" };
  const match = organizationForMdmServer(enrollment.serverUrl);
  if (match === null) return { kind: "unmatched" };
  return {
    kind: "matched",
    organization: {
      entry: match.entry,
      evidence: match.entry.evidence(match.host),
      endpoint: match.entry.preset.endpoint,
      forced: false,
    },
  };
}

/**
 * The lock a managed Mac keeps when its enrollment could not be read at start.
 *
 * Nothing is applied or withdrawn on an unreadable answer, so the stored managed settings stay
 * exactly as they are - and so does the lock over them, named after the organization the stored
 * record belongs to. A later start or Re-check reads again.
 */
export function heldOrganization(entry: OrganizationEntry): DetectedOrganization {
  return {
    entry,
    evidence: `Mission Control could not read this Mac's device management enrollment just now, so the telemetry settings ${entry.label} manages stay as they are. Re-check tries again.`,
    endpoint: entry.preset.endpoint,
    forced: false,
  };
}

/**
 * `MISSION_ORGANIZATION=<id>`, honoured only with a loopback `MISSION_ORGANIZATION_ENDPOINT`.
 *
 * The force bypasses detection and every guard, which is what lets a browser test drive the
 * managed panel end to end. The loopback requirement is what keeps it from being anything
 * else: a forced organization can only ever send to a collector on this machine, never to the
 * organization's real gateway.
 */
function forcedOrganization(
  override: string,
  deps: OrganizationDetectionDeps,
): DetectedOrganization | null {
  const id = ORGANIZATION_IDS.find((candidate) => candidate === override);
  if (id === undefined) {
    deps.warn(
      `[organization] ignoring MISSION_ORGANIZATION=${override}: not a known organization or "none"`,
    );
    return null;
  }
  const endpoint = envValue(deps.env, "ORGANIZATION_ENDPOINT")?.trim() ?? "";
  if (!isLoopbackUrl(endpoint)) {
    deps.warn(
      `[organization] ignoring MISSION_ORGANIZATION=${id}: MISSION_ORGANIZATION_ENDPOINT must be an http(s) URL on this machine`,
    );
    return null;
  }
  const entry = ORGANIZATIONS[id];
  return {
    entry,
    evidence: `MISSION_ORGANIZATION forces ${entry.label} on this daemon, sending to a collector on this machine (${endpoint}).`,
    endpoint,
    forced: true,
  };
}

/** `envVar`'s MISSION_, FLEET_, HARNESS_ chain, over the injected environment. */
function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`MISSION_${suffix}`] ?? env[`FLEET_${suffix}`] ?? env[`HARNESS_${suffix}`];
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

// ---- the cached answer ----
//
// Computed once at start and again on Re-check, never per request: detection runs a
// subprocess, and the settings lock and the resource environment read it on hot paths.

let current: DetectedOrganization | null = null;
let launchMode: OrganizationLaunchMode = "dev";

/** The organization this daemon last recognized, or null. */
export function currentOrganization(): DetectedOrganization | null {
  return current;
}

/** Record how this daemon was launched, once, before the first detection. */
export function configureOrganizationLaunchMode(mode: OrganizationLaunchMode): void {
  launchMode = mode;
}

/** What detection reads on this machine. Built per call, so nothing is frozen at import. */
export function defaultOrganizationDetectionDeps(): OrganizationDetectionDeps {
  return {
    platform: process.platform,
    env: process.env,
    launchMode,
    stateHome: stateDir(),
    tmpdir: tmpdir(),
    realpath: (path) => realpath(path),
    run,
    warn: (message) => console.warn(message),
  };
}

/** Detect again and replace the cached answer. */
export async function refreshOrganization(
  deps: OrganizationDetectionDeps = defaultOrganizationDetectionDeps(),
): Promise<DetectedOrganization | null> {
  current = await detectOrganization(deps);
  return current;
}

/**
 * Replace the cached answer with one the caller has already settled.
 *
 * The recheck path's way in: it detects, applies, and only then publishes, so the lock never
 * drops while a withdrawal is still unwritten. `refreshOrganization` remains for callers that
 * only want to know what the machine says.
 */
export function publishOrganization(organization: DetectedOrganization | null): void {
  current = organization;
}
