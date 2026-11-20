import type { ModHost } from "../host.ts";

/** The text a stub flow shows the person. */
export const FLOW_NOT_IMPLEMENTED = "not implemented";

/**
 * The `start_dispatch` tool, the quick path (7.20).
 * Owner: P11. Replace the body and keep the signature.
 */
export async function runStartDispatchTool(host: ModHost, input: { kind?: string; brief?: string }): Promise<void> {
  void input;
  host.notice(FLOW_NOT_IMPLEMENTED);
}
