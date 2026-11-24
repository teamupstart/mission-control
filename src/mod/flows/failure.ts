import type { ModHost } from "../host.ts";
import type { FlowSession } from "./routes.ts";

/** The one line the person sees when a flow throws; every expected failure comes back as an outcome instead. */
export const FLOW_FAILED_TEXT = "Mission Control could not finish that dispatch. Run /mission-dispatch again.";

/**
 * Records what actually failed on the debug channel, then tells the person the friendly line. An
 * exception reaching here is a bug (down, off, refused and ended are all outcomes), so the first
 * lines of its stack are kept for diagnosis in the field.
 */
export function reportFlowFailure(
  host: Pick<ModHost, "notice">,
  debug: (text: string) => void,
  error: unknown,
  session?: Pick<FlowSession, "live">,
): void {
  const detail = error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join(" | ") : String(error);
  debug(`mission-control: the dispatch flow threw: ${detail}`);
  // A flow that threw after its session ended must not tell whichever session is current now about
  // a dispatch that person never started: the debug line above is all it leaves.
  if (session?.live && !session.live()) return;
  host.notice(FLOW_FAILED_TEXT);
}
