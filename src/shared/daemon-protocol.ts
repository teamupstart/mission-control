/**
 * Capabilities that let independently updated clients prove the daemon speaks the wire
 * contract they are about to use. Keep values append-only: an older client may inspect a
 * newer daemon, and an older daemon simply omits capabilities it does not understand.
 */
export const DAEMON_PROTOCOL_CAPABILITIES = {
  criterionMappedWorkflowEvidence: "criterion-mapped-workflow-evidence-v1",
  daemonExecutableEnvironment: "daemon-executable-environment-v1",
  multipleScoutReports: "multiple-scout-reports-v1",
  explicitScoutFiles: "explicit-scout-files-v1",
  workflowCoverageMutations: "workflow-coverage-mutations-v1",
  /**
   * Headless mode's `/dispatch/*` routes. Unlike the others, `GET /api/health` lists it only
   * while the `headless-mode` flag is on (`advertisedDaemonCapabilities`).
   */
  homeDispatch: "home-dispatch-v1",
} as const;

export type DaemonProtocolCapability =
  (typeof DAEMON_PROTOCOL_CAPABILITIES)[keyof typeof DAEMON_PROTOCOL_CAPABILITIES];

/** The capabilities `GET /api/health` lists, given the flags that gate some of them. */
export function advertisedDaemonCapabilities(
  flags: { headlessMode: boolean },
): DaemonProtocolCapability[] {
  return Object.values(DAEMON_PROTOCOL_CAPABILITIES).filter(
    (capability) => capability !== DAEMON_PROTOCOL_CAPABILITIES.homeDispatch || flags.headlessMode,
  );
}

export type DaemonCompatibility = "compatible" | "incompatible" | "unreachable";

export function daemonHealthCompatibility(
  value: unknown,
  capability: DaemonProtocolCapability,
): DaemonCompatibility {
  if (typeof value !== "object" || value === null) return "unreachable";
  const health = value as { service?: unknown; capabilities?: unknown };
  if (health.service !== "mission-control") return "unreachable";
  return Array.isArray(health.capabilities) && health.capabilities.includes(capability)
    ? "compatible"
    : "incompatible";
}

/** Browser-safe structural check for the unauthenticated loopback health response. */
export function daemonHealthSupports(
  value: unknown,
  capability: DaemonProtocolCapability,
): boolean {
  return daemonHealthCompatibility(value, capability) === "compatible";
}

/** Whether a workflow-evidence request would be changed or rejected by the older wire shape. */
export function workflowEvidenceNeedsCriterionMappedCapability(input: {
  coverage?: readonly unknown[];
  commandOutputs?: readonly { exitCode: number }[];
}): boolean {
  return (input.coverage?.length ?? 0) > 0
    || (input.commandOutputs ?? []).some((item) => item.exitCode < 0);
}
