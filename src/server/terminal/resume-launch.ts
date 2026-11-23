import { terminalEnvironmentArgv } from "./environment-handoff.ts";
import type { PreparedResume } from "../harness/resume.ts";
import { TerminalLaunchError } from "./launch-error.ts";
import { resumeLeaseStatus } from "./resume-lease.ts";
import {
  expectTerminalLaunchWorkUnit,
  settleTerminalLaunchWorkUnit,
  type TerminalLaunchWorkUnit,
} from "../terminal-launch-work-units.ts";

/** A managed launch has no second argv, cwd or state-home input to disagree with preparation. */
export interface ManagedResumeLaunch {
  name: string;
  prepared: PreparedResume;
}

export interface ResumeLaunchResult<T> {
  outcome: "launched" | "refused" | "unknown";
  value: T;
}

/**
 * Both managed terminal paths transfer preparation ownership here. Record intent before
 * backend I/O; revoke only a definite non-launch, and retain every uncertain/claimed home.
 * Callers dispose only when abandoning preparation before invoking a managed launcher.
 * Backend adapters receive the exact command being executed, never a second plain argv.
 */
export async function launchPreparedResume<T>(
  input: ManagedResumeLaunch,
  launch: (command: { name: string; cwd: string; argv: string[]; stateHome: string }) => Promise<ResumeLaunchResult<T>>,
): Promise<ResumeLaunchResult<T>> {
  const { prepared } = input;
  // A repeated call does not own an earlier attempt's pending or claimed environment.
  if (resumeLeaseStatus(prepared.lease).state !== "preparing") {
    throw new TerminalLaunchError("Managed resume launch was already attempted; recheck its status", true);
  }
  let handoff: Awaited<ReturnType<typeof terminalEnvironmentArgv>> | undefined;
  let attempted = false;
  // The resume's work unit decision, handed over before the pane exists so the registry can
  // install it as the resumed session's launch record when it first sees the agent beneath this
  // lease's guard - keyed by the lease's own home, which no other pane runs from. A terminal
  // that opened confirms it; a definite non-launch started nothing, so it is withdrawn. An
  // uncertain outcome leaves it waiting: only the agent this launch started can take it.
  let expected: TerminalLaunchWorkUnit | null = null;
  try {
    prepared.beginLaunch();
    // Terminal target discovery also imports this module. Only launches need the settings database.
    const { launchAgentEnvironment } = await import("../agent-environment.ts");
    const named = await launchAgentEnvironment(prepared.resident);
    handoff = await terminalEnvironmentArgv(prepared.wrappedArgv, prepared, named);
    attempted = true;
    expected = expectTerminalLaunchWorkUnit(prepared.stateHome, prepared.workUnitId, prepared.conversationKey, named?.missing);
    const result = await launch({ name: input.name, cwd: prepared.cwd,
      argv: handoff.argv, stateHome: prepared.stateHome });
    if (result.outcome === "launched") settleTerminalLaunchWorkUnit(expected, "succeeded");
    if (result.outcome === "refused") {
      handoff.dispose();
      settleTerminalLaunchWorkUnit(expected, "not-started");
    }
    if (result.outcome === "refused" && !prepared.dispose()) return { ...result, outcome: "unknown" };
    return result;
  } catch (error) {
    const definite = !attempted || (error instanceof TerminalLaunchError && !error.outcomeUnknown);
    if (definite) {
      handoff?.dispose();
      settleTerminalLaunchWorkUnit(expected, "not-started");
    }
    let revoked = false;
    if (definite) {
      try { revoked = prepared.dispose(); } catch { /* Failed cleanup cannot establish a safe retry. */ }
    }
    const message = !attempted ? "Managed resume could not record its launch intent"
      : error instanceof Error ? error.message : "Managed terminal launch failed";
    throw new TerminalLaunchError(message, !revoked);
  }
}
