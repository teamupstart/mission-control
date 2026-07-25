import type { Session } from "@shared/types.ts";
import type { SdkSupervisor } from "./supervisor.ts";

/**
 * Delivering a turn to an embedded session - the driver arm of `/send` and `/inject`.
 *
 * The whole point of the runtime, in one function. The pane path is a NON-ATOMIC sequence
 * (buffer, paste, settle, Enter, read the composer back) whose failures are ambiguous by
 * construction: `InjectResult.pasted` exists because "it failed" and "nothing landed" are
 * different claims there, and `submitVerified` exists because an Enter a TUI swallowed
 * looks exactly like one it took. None of those states can occur here. `send()` resolves
 * when the harness ACCEPTED the turn, so:
 *
 *  - success is `pasted: true, submitVerified: true` - it is one call, and the harness
 *    said yes;
 *  - failure is `pasted: false, submitVerified: false` - the call rejected, so nothing
 *    was appended to any composer and a caller may safely retry.
 *
 * That second line is what makes the queue's `mayHaveLanded` arm unreachable for these
 * sessions rather than merely unused. It is stated here, once, so `/send` and `/inject`
 * cannot drift into two answers about the same call.
 */
export interface SdkDelivery {
  ok: boolean;
  error?: string;
  pasted: boolean;
  submitVerified: boolean;
}

export async function deliverToDriver(
  supervisor: SdkSupervisor | undefined,
  session: Session,
  text: string,
): Promise<SdkDelivery> {
  const failed = (error: string): SdkDelivery => ({
    ok: false,
    error,
    pasted: false,
    submitVerified: false,
  });
  if (!supervisor) return failed("this build has no session supervisor");
  try {
    await supervisor.send(session.id, { text });
    return { ok: true, pasted: true, submitVerified: true };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}
