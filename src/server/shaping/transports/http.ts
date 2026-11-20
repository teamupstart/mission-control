import type { ShapingTransport } from "./types.ts";

/** Placeholder until its phase lands. The id and config schema are already declared, so stored shapers keep their shape. */
export const callHttp: ShapingTransport<"http"> = async () => ({
  kind: "unavailable",
  reason: "The HTTP transport is not available in this build yet.",
});
