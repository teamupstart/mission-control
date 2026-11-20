import type { ModHost } from "../host.ts";

export const FLOW_NOT_IMPLEMENTED = "not implemented";

/**
 * The dispatch dialogs and the draft (7.5, 7.6, 7.11).
 * Owner: P11. Replace the body and keep the signature.
 */
export async function runDispatchFlow(host: ModHost, input: { kind?: string; words?: string }): Promise<void> {
  void input;
  host.notice(FLOW_NOT_IMPLEMENTED);
}
