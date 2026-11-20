import type { ModHost } from "../host.ts";

/** The text a stub flow shows the person. */
export const FLOW_NOT_IMPLEMENTED = "not implemented";

/**
 * The `/mission-dispatch` command (7.11): launcher, fast path, description, and the `inbox`, `check`, `pane` and task-id arguments.
 * Owner: P11. Replace the body and keep the signature.
 */
export async function runDispatchCommand(host: ModHost, args: string): Promise<void> {
  void args;
  host.notice(FLOW_NOT_IMPLEMENTED);
}
