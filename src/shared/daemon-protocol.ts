/**
 * Capabilities that let independently updated clients prove the daemon speaks the wire
 * contract they are about to use. Keep values append-only: an older client may inspect a
 * newer daemon, and an older daemon simply omits capabilities it does not understand.
 */
export const DAEMON_PROTOCOL_CAPABILITIES = {
  criterionMappedWorkflowEvidence: "criterion-mapped-workflow-evidence-v1",
  daemonExecutableEnvironment: "daemon-executable-environment-v1",
} as const;

export type DaemonProtocolCapability =
  (typeof DAEMON_PROTOCOL_CAPABILITIES)[keyof typeof DAEMON_PROTOCOL_CAPABILITIES];

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
