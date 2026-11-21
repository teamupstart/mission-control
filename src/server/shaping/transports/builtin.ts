import type { ShaperTransport, ShapingBuiltinId, ShapingRequest } from "@shared/shaping.ts";
import { SHAPING_BUILTINS } from "@shared/shaping-registry.ts";
import { callRepositoryFiles } from "../builtin/repository-files.ts";
import type { ShapingTransport, TransportContext, TransportReply } from "./types.ts";

type BuiltinTransportOf<Id extends ShapingBuiltinId> = Extract<ShaperTransport, { type: "builtin"; builtin: Id }>;

type BuiltinCall<Id extends ShapingBuiltinId> = (
  request: ShapingRequest,
  transport: BuiltinTransportOf<Id>,
  ctx: TransportContext,
) => Promise<TransportReply>;

/**
 * One implementation per built-in id. Exhaustive: an id appended to `SHAPING_BUILTINS` fails to
 * compile here until it has one. Which stages each serves is the registry's, not this table's.
 */
export const SHAPING_BUILTIN_CALLS: { readonly [Id in ShapingBuiltinId]: BuiltinCall<Id> } = {
  "repository-files": (request, transport, ctx) => callRepositoryFiles(request, transport.options, ctx),
};

/** Reach a built-in by its id. One that does not serve the request's stage answers `unavailable`. */
export const callBuiltin: ShapingTransport<"builtin"> = async (request, shaper, ctx) => {
  const { transport } = shaper;
  const declared = SHAPING_BUILTINS.find((builtin) => builtin.id === transport.builtin);
  const call = SHAPING_BUILTIN_CALLS[transport.builtin] as BuiltinCall<ShapingBuiltinId> | undefined;
  if (!declared || !call) {
    return { kind: "unavailable", reason: `This build has no built-in shaper "${String(transport.builtin)}".` };
  }
  if (!(declared.stages as readonly string[]).includes(request.stage)) {
    return { kind: "unavailable", reason: `The built-in "${declared.id}" does not run at the ${request.stage} stage.` };
  }
  return call(request, transport, ctx);
};
