import type { PreparedResume } from "../harness/resume.ts";
import { TerminalLaunchError } from "./launch-error.ts";
import { resumeLeaseStatus } from "./resume-lease.ts";

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
  let attempted = false;
  try {
    prepared.beginLaunch();
    attempted = true;
    const result = await launch({ name: input.name, cwd: prepared.cwd,
      argv: prepared.wrappedArgv, stateHome: prepared.stateHome });
    if (result.outcome === "refused" && !prepared.dispose()) return { ...result, outcome: "unknown" };
    return result;
  } catch (error) {
    const definite = !attempted || (error instanceof TerminalLaunchError && !error.outcomeUnknown);
    let revoked = false;
    if (definite) {
      try { revoked = prepared.dispose(); } catch { /* Failed cleanup cannot establish a safe retry. */ }
    }
    const message = !attempted ? "Managed resume could not record its launch intent"
      : error instanceof Error ? error.message : "Managed terminal launch failed";
    throw new TerminalLaunchError(message, !revoked);
  }
}
