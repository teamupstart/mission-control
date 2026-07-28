import type { SdkSendDisposition, Session } from "@shared/types.ts";
import {
  injectPrompt,
  type InjectDeps,
  type InjectResult,
  type PromptWriteGuard,
} from "../actions.ts";
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
 *    said yes; `delivery` says whether it started, steered, or queued the turn;
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
  /** How the driver accepted the turn; absent on refusal. */
  delivery?: SdkSendDisposition;
}

export async function deliverToDriver(
  supervisor: SdkSupervisor | undefined,
  session: Session,
  text: string,
  beforeSend?: PromptWriteGuard,
): Promise<SdkDelivery> {
  const failed = (error: string): SdkDelivery => ({
    ok: false,
    error,
    pasted: false,
    submitVerified: false,
  });
  if (!supervisor) return failed("this build has no session supervisor");
  try {
    const blocked = beforeSend?.();
    if (blocked) return failed(blocked);
    // The second guard runs inside the supervisor's per-session serialization. The first
    // catches an already-invalid target without entering its send queue; the second closes
    // the window in which a queued reset or handoff could change the conversation.
    const delivery = await supervisor.send(session.id, { text }, beforeSend);
    return { ok: true, pasted: true, submitVerified: true, delivery };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Deliver one complete prompt through the runtime that owns the session.
 *
 * `/inject`, workflow repair delivery, and any future deterministic prompt sender must all
 * make the same runtime decision. Keeping it here prevents a caller from sending an embedded
 * session to the pane-only `injectPrompt`, where the safety backstop correctly refuses it and
 * leaves the agent idle.
 */
export async function injectPromptForRuntime(
  supervisor: SdkSupervisor | undefined,
  session: Session,
  text: string,
  deps?: InjectDeps,
  beforeWrite?: PromptWriteGuard,
): Promise<InjectResult> {
  if (session.runtime !== "sdk") {
    return injectPrompt(session, text, deps, beforeWrite);
  }
  return deliverToDriver(supervisor, session, text, beforeWrite);
}

/** Bind the daemon's one supervisor into a pane-compatible injector dependency. */
export function runtimePromptInjector(supervisor: SdkSupervisor | undefined): typeof injectPrompt {
  return (session, text, deps, beforeWrite) =>
    injectPromptForRuntime(supervisor, session, text, deps, beforeWrite);
}
