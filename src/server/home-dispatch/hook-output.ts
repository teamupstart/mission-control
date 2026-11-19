import type { HookDispatchOutput } from "@shared/home-dispatch.ts";
import type { HookIngest } from "@shared/protocol.ts";

/**
 * What the hook route adds to its response for a home session (spec 7.3). The route calls this
 * only while `headless-mode` is on, once per event, never cached. Stub (owner: WP2a): `null`
 * means "no `dispatch` field", which is exactly today's response.
 */
export function homeDispatchHookOutput(_hook: HookIngest): HookDispatchOutput | null {
  return null;
}
