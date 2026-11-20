import type { Shaper, ShapingRequest, ShapingTransportId } from "@shared/shaping.ts";
import { callBuiltin } from "./builtin.ts";
import { callCommand } from "./command.ts";
import { callHttp } from "./http.ts";
import { callMcp } from "./mcp.ts";
import type { ShaperOf, ShapingTransport, TransportContext, TransportReply } from "./types.ts";

export type { ShapingRunScope, ShapingTransport, TransportContext, TransportReply } from "./types.ts";

export type ShapingTransportCalls = { readonly [Id in ShapingTransportId]: ShapingTransport<Id> };

/** One implementation per transport id. Exhaustive: a new id in the registry fails to compile here. */
export const SHAPING_TRANSPORT_CALLS: ShapingTransportCalls = {
  command: callCommand,
  mcp: callMcp,
  http: callHttp,
  builtin: callBuiltin,
};

/** Reach `shaper` over its own transport. Never throws: a transport that throws has failed. */
export async function callTransport(
  request: ShapingRequest,
  shaper: Shaper,
  ctx: TransportContext,
  calls: ShapingTransportCalls = SHAPING_TRANSPORT_CALLS,
): Promise<TransportReply> {
  const call = calls[shaper.transport.type] as ShapingTransport;
  try {
    return await call(request, shaper as ShaperOf<ShapingTransportId>, ctx);
  } catch (error) {
    return { kind: "failed", reason: `The ${shaper.transport.type} transport failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
