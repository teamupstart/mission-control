import type { ModHost } from "../host.ts";

/** The one line the person sees when a flow throws; every expected failure comes back as an outcome instead. */
export const FLOW_FAILED_TEXT = "Mission Control could not finish that dispatch. Run /mission-dispatch again.";

/**
 * Records what actually failed on the debug channel, then tells the person the friendly line. An
 * exception reaching here is a bug (down, off, refused and ended are all outcomes), so the first
 * lines of its stack are kept for diagnosis in the field.
 */
export function reportFlowFailure(host: Pick<ModHost, "notice">, debug: (text: string) => void, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message).split("\n").slice(0, 4).join(" | ") : String(error);
  debug(`mission-control: the dispatch flow threw: ${detail}`);
  host.notice(FLOW_FAILED_TEXT);
}
